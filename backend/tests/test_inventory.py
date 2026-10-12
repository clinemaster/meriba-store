"""Opening stock, adjustments, go-live and product rules."""
import uuid

from catalog.models import Product
from core.models import AuditLog
from inventory.models import InventoryMovement

from .conftest import client_for, stock_of


def count_payload(lines, key=None, reason="Physical count"):
    return {"request_key": str(key or uuid.uuid4()), "reason": reason,
            "lines": [{"product": p.pk, "quantity": str(q)} for p, q in lines]}


def not_live(shop):
    shop.cfg.went_live_at = None
    shop.cfg.opening_stock_confirmed_at = None
    shop.cfg.save()


def test_opening_stock_is_entered_once_before_go_live(owner, shop, make_product):
    not_live(shop)
    a, b = make_product("A"), make_product("B")
    client = client_for(owner)
    key = uuid.uuid4()
    first = client.post("/api/v1/stock/opening/", count_payload([(a, 48), (b, 0)], key), format="json")
    retry = client.post("/api/v1/stock/opening/", count_payload([(a, 48), (b, 0)], key), format="json")
    assert (first.status_code, retry.status_code) == (201, 200) and retry.data["already_saved"] is True
    assert stock_of(a) == 48 and InventoryMovement.objects.filter(movement_type="OPENING").count() == 1
    twice = client.post("/api/v1/stock/opening/", count_payload([(a, 10)]), format="json")
    assert twice.status_code == 409 and twice.data["code"] == "opening_exists"
    assert stock_of(a) == 48
    movement = InventoryMovement.objects.get()
    assert (movement.user, movement.reason, movement.source_type) == (owner, "Physical count", "StockAdjustment")


def test_guided_setup_blocks_go_live_until_every_step_is_done(owner, shop, make_user, make_product):
    not_live(shop)
    client = client_for(owner)
    status = client.get("/api/v1/setup/status/").data
    assert status["ready_to_go_live"] is False and status["is_live"] is False
    early = client.post("/api/v1/setup/go-live/", {"opening_cumulative_sales": "0", "confirm": True}, format="json")
    assert early.status_code == 409 and early.data["code"] == "setup_incomplete"

    product = make_product()
    make_user("till1", "CASHIER")
    client.post("/api/v1/stock/opening/", count_payload([(product, 12)]), format="json")
    assert client.post("/api/v1/stock/opening/confirm/").status_code == 200
    assert client.get("/api/v1/setup/status/").data["ready_to_go_live"] is True
    unticked = client.post("/api/v1/setup/go-live/", {"opening_cumulative_sales": "0", "confirm": False}, format="json")
    assert unticked.data["code"] == "not_confirmed"
    live = client.post("/api/v1/setup/go-live/", {"opening_cumulative_sales": "750000", "confirm": True}, format="json")
    assert live.status_code == 200 and live.data["is_live"] is True and live.data["opening_cumulative_sales"] == "750000.00"
    again = client.post("/api/v1/setup/go-live/", {"opening_cumulative_sales": "1", "confirm": True}, format="json")
    assert again.data["code"] == "already_live"  # the opening balance cannot be changed afterwards
    late = client.post("/api/v1/stock/opening/", count_payload([(make_product("New"), 5)]), format="json")
    assert late.data["code"] == "already_live"
    assert AuditLog.objects.filter(action="setup.went_live").count() == 1


def test_adjustment_records_who_when_why_and_keeps_history(accountant, shop, make_product):
    product = make_product(stock=20)
    client = client_for(accountant)
    no_reason = client.post("/api/v1/stock/adjustments/", count_payload([(product, 18)], reason=""), format="json")
    assert no_reason.status_code == 400
    done = client.post("/api/v1/stock/adjustments/", count_payload([(product, 18)], reason="2 bottles broken") | {"kind": "DAMAGE"}, format="json")
    assert done.status_code == 201 and stock_of(product) == 18
    movement = InventoryMovement.objects.get(movement_type="ADJUSTMENT")
    assert (movement.quantity_delta, movement.balance_before, movement.balance_after) == (-2, 20, 18)
    assert (movement.user, movement.reason) == (accountant, "2 bottles broken")
    assert InventoryMovement.objects.filter(product=product).count() == 2  # opening line still there
    history = client.get(f"/api/v1/stock/movements/?product={product.pk}").data["results"]
    assert [m["movement_type"] for m in history] == ["ADJUSTMENT", "OPENING"]
    negative = client.post("/api/v1/stock/adjustments/", count_payload([(product, -1)], reason="oops"), format="json")
    assert negative.status_code == 400


def test_product_rules(owner, make_product):
    client = client_for(owner)
    created = client.post("/api/v1/products/", {"name": "  Konyagi   ndogo ", "selling_price": "4500", "base_unit": "Bottle",
                                                "package_size": "200ml", "barcode": "600123"}, format="json")
    assert created.status_code == 201 and created.data["name"] == "Konyagi ndogo" and created.data["sku"].startswith("P")
    dup = client.post("/api/v1/products/", {"name": "Other", "selling_price": "1", "barcode": "600123"}, format="json")
    assert dup.status_code == 400 and "barcode" in dup.data["errors"]
    assert client.post("/api/v1/products/", {"name": "Bad", "selling_price": "-5"}, format="json").status_code == 400
    pk = created.data["id"]
    assert client.patch(f"/api/v1/products/{pk}/", {"selling_price": "5000"}, format="json").status_code == 200
    log = AuditLog.objects.get(action="product.price_changed")
    assert (log.before, log.after, log.actor) == ({"selling_price": "4500.00"}, {"selling_price": "5000.00"}, owner)
    assert client.delete(f"/api/v1/products/{pk}/").status_code == 405  # FR-PROD-06: deactivate, never delete
    assert client.patch(f"/api/v1/products/{pk}/", {"is_active": False}, format="json").status_code == 200
    assert Product.objects.filter(pk=pk).exists()


def test_search_by_name_code_and_barcode(cashier, make_product):
    make_product("Konyagi ndogo", package_size="200ml", barcode="111")
    make_product("Konyagi kubwa", package_size="750ml")
    make_product("Serengeti", is_active=False)
    client = client_for(cashier)
    names = lambda q: [p["name"] for p in client.get(f"/api/v1/products/?search={q}").data["results"]]
    assert names("konyagi") == ["Konyagi kubwa", "Konyagi ndogo"]
    assert names("kony 750") == ["Konyagi kubwa"]
    assert names("111") == ["Konyagi ndogo"]
    assert names("serengeti") == []  # products that are switched off are not offered to cashiers
