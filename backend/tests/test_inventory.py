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


def sheet_payload(lines, key=None, **extra):
    return {"request_key": str(key or uuid.uuid4()), "count_date": "2026-10-31", "counted_by_name": "Asha and Juma",
            "lines": [{"product": p.pk, "quantity": str(q)} for p, q in lines]} | extra


def test_opening_stock_is_a_physical_count_sheet_that_only_the_owner_can_approve(owner, accountant, cashier, shop, make_product):
    not_live(shop)
    a, b = make_product("A"), make_product("B")
    prep, boss = client_for(accountant), client_for(owner)
    key = uuid.uuid4()
    first = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(a, 48)], key), format="json")
    retry = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(a, 48)], key), format="json")
    assert (first.status_code, retry.status_code) == (201, 200) and retry.data["id"] == first.data["id"]
    sheet = first.data["id"]
    assert first.data["status"] == "PENDING_REVIEW" and first.data["lines"][0]["unit"] == "Bottle"

    # nothing is live stock until the Owner approves
    assert stock_of(a) == 0 and not InventoryMovement.objects.exists()
    another = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(b, 5)]), format="json")
    assert another.status_code == 409 and another.data["code"] == "count_pending"

    # the sheet can be corrected and added to while it is pending
    edited = prep.put(f"/api/v1/stock/opening-counts/{sheet}/", sheet_payload([(a, 46), (b, 0)]), format="json")
    assert edited.status_code == 200 and {l["product_name"]: l["counted_quantity"] for l in edited.data["lines"]} == {"A": "46.000", "B": "0.000"}

    assert client_for(cashier).get("/api/v1/stock/opening-counts/").status_code == 403
    assert prep.post(f"/api/v1/stock/opening-counts/{sheet}/review/", {"approve": True}, format="json").status_code == 403  # Owner only
    approved = boss.post(f"/api/v1/stock/opening-counts/{sheet}/review/", {"approve": True}, format="json")
    assert approved.status_code == 200 and approved.data["status"] == "APPROVED" and approved.data["reviewed_by_name"] == "Owner"
    assert (stock_of(a), stock_of(b)) == (46, 0)
    line_a = next(l for l in approved.data["lines"] if l["product_name"] == "A")
    movement = InventoryMovement.objects.get()  # a zero count needs no movement
    assert (line_a["approved_quantity"], line_a["movement"]) == ("46.000", movement.pk)
    assert (movement.movement_type, movement.source_type, movement.source_id, movement.user) == ("OPENING", "OpeningCount", str(sheet), owner)
    assert "Asha and Juma" in movement.reason

    # approved sheets are closed; repeating the approval changes nothing; a correction needs a new sheet
    assert boss.post(f"/api/v1/stock/opening-counts/{sheet}/review/", {"approve": True}, format="json").status_code == 200
    assert InventoryMovement.objects.count() == 1
    assert prep.put(f"/api/v1/stock/opening-counts/{sheet}/", sheet_payload([(a, 1)]), format="json").data["code"] == "count_closed"
    fix = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(a, 47)], note="Found one more behind the counter"), format="json")
    refused = boss.post(f"/api/v1/stock/opening-counts/{fix.data['id']}/review/", {"approve": False}, format="json")
    assert refused.status_code == 400 and refused.data["code"] == "note_required"
    assert boss.post(f"/api/v1/stock/opening-counts/{fix.data['id']}/review/", {"approve": False, "note": "Recount with me present"}, format="json").data["status"] == "REJECTED"
    assert stock_of(a) == 46
    fix2 = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(a, 47)]), format="json")
    boss.post(f"/api/v1/stock/opening-counts/{fix2.data['id']}/review/", {"approve": True}, format="json")
    assert stock_of(a) == 47 and InventoryMovement.objects.filter(product=a).count() == 2  # both entries stay in the ledger
    actions = set(AuditLog.objects.values_list("action", flat=True))
    assert {"stock.opening_count_saved", "stock.opening_count_approved", "stock.opening_count_rejected"} <= actions


def go_live_body(amount, **extra):
    return {"opening_cumulative_sales": amount, "as_of_date": "2026-10-31", "confirm": True} | extra


def approve_count(boss, lines):
    sheet = boss.post("/api/v1/stock/opening-counts/", sheet_payload(lines), format="json")
    assert sheet.status_code == 201, sheet.data
    done = boss.post(f"/api/v1/stock/opening-counts/{sheet.data['id']}/review/", {"approve": True}, format="json")
    assert done.status_code == 200, done.data


def test_guided_setup_and_owner_approval_of_the_opening_balance(owner, accountant, shop, make_user, make_product):
    not_live(shop)
    boss, prep = client_for(owner), client_for(accountant)
    status = boss.get("/api/v1/setup/status/").data
    assert status["ready_to_go_live"] is False and status["is_live"] is False
    early = boss.post("/api/v1/setup/go-live/", go_live_body("0", confirm_new_baseline=True), format="json")
    assert early.status_code == 409 and early.data["code"] == "setup_incomplete"

    product, second = make_product("Konyagi"), make_product("Safari")
    make_user("till1", "CASHIER")
    sheet = prep.post("/api/v1/stock/opening-counts/", sheet_payload([(product, 12)]), format="json").data["id"]
    step = lambda: next(s for s in boss.get("/api/v1/setup/status/").data["steps"] if s["key"] == "opening_stock")
    assert step()["done"] is False and "waiting for the Owner" in step()["detail"]
    boss.post(f"/api/v1/stock/opening-counts/{sheet}/review/", {"approve": True}, format="json")
    # every product on sale needs an approved count before live inventory is switched on
    assert step()["done"] is False and "1 product(s) on sale have no approved count" in step()["detail"]
    blocked = boss.post("/api/v1/setup/go-live/", go_live_body("750000"), format="json")
    assert blocked.status_code == 409 and blocked.data["code"] == "setup_incomplete"
    approve_count(boss, [(second, 0)])  # an explicit count of zero is a valid count
    assert step()["done"] is True

    # the Accountant reconciles and prepares a figure; that approves nothing
    prepared = prep.put("/api/v1/setup/opening-balance/", {"opening_cumulative_sales": "750000", "as_of_date": "2026-10-31",
                                                           "note": "Reconciled to the October sheets"}, format="json")
    assert prepared.status_code == 200
    status = prep.get("/api/v1/setup/status/").data
    assert status["prepared_opening_cumulative_sales"] == "750000.00" and status["opening_balance_prepared_by"] == "Accountant"
    assert status["ready_to_go_live"] is True and status["is_live"] is False
    shop.cfg.refresh_from_db()
    assert shop.cfg.opening_cumulative_sales == 0 and not shop.cfg.is_live
    assert prep.post("/api/v1/setup/go-live/", go_live_body("750000"), format="json").status_code == 403  # Owner only

    missing = boss.post("/api/v1/setup/go-live/", {"confirm": True}, format="json")
    assert missing.status_code == 400 and {"opening_cumulative_sales", "as_of_date"} <= set(missing.data["errors"])
    assert boss.post("/api/v1/setup/go-live/", go_live_body("750000", confirm=False), format="json").data["code"] == "not_confirmed"
    zero = boss.post("/api/v1/setup/go-live/", go_live_body("0"), format="json")
    assert zero.status_code == 400 and zero.data["code"] == "zero_needs_confirmation"
    shop.cfg.refresh_from_db()
    assert not shop.cfg.is_live

    live = boss.post("/api/v1/setup/go-live/", go_live_body("750000"), format="json")
    assert live.status_code == 200 and live.data["is_live"] is True and live.data["opening_cumulative_sales"] == "750000.00"
    again = boss.post("/api/v1/setup/go-live/", go_live_body("1"), format="json")
    assert again.data["code"] == "already_live"
    assert prep.put("/api/v1/setup/opening-balance/", {"opening_cumulative_sales": "1", "as_of_date": "2026-10-31"}, format="json").data["code"] == "already_live"
    late = boss.post("/api/v1/stock/opening-counts/", sheet_payload([(product, 5)]), format="json")
    assert late.data["code"] == "already_live"  # after go-live, only recorded adjustments change stock
    log = AuditLog.objects.get(action="setup.went_live")
    assert log.actor == owner and log.after["opening_cumulative_sales"] == "750000.00" and log.after["prepared_by"] == "accountant"


def test_zero_opening_balance_is_allowed_as_a_confirmed_new_baseline(owner, shop, make_user, make_product):
    not_live(shop)
    boss = client_for(owner)
    make_user("till1", "CASHIER")
    approve_count(boss, [(make_product(), 12)])
    live = boss.post("/api/v1/setup/go-live/", go_live_body("0", confirm_new_baseline=True), format="json")
    assert live.status_code == 200 and live.data["opening_cumulative_sales"] == "0.00"
    assert AuditLog.objects.get(action="setup.went_live").after["new_baseline"] is True


def test_a_product_cannot_be_on_sale_without_a_selling_price(owner):
    client = client_for(owner)
    refused = client.post("/api/v1/products/", {"name": "mkwawa"}, format="json")
    assert refused.status_code == 400 and "selling_price" in refused.data["errors"]
    kept = client.post("/api/v1/products/", {"name": "mkwawa", "is_active": False}, format="json")
    assert kept.status_code == 201 and kept.data["is_active"] is False
    switch_on = client.patch(f"/api/v1/products/{kept.data['id']}/", {"is_active": True}, format="json")
    assert switch_on.status_code == 400 and Product.objects.get(pk=kept.data["id"]).is_active is False
    assert client.patch(f"/api/v1/products/{kept.data['id']}/", {"is_active": True, "selling_price": "2500"}, format="json").status_code == 200


def test_adjustment_records_who_when_why_and_keeps_history(accountant, shop, make_product):
    product = make_product(stock=20)
    client = client_for(accountant)
    damage_payload = {"request_key": str(uuid.uuid4()), "reason": "2 bottles broken",
                      "lines": [{"product": product.pk, "quantity": "2"}]}
    no_reason = client.post("/api/v1/stock/damaged/", damage_payload | {"reason": ""}, format="json")
    assert no_reason.status_code == 400
    done = client.post("/api/v1/stock/damaged/", damage_payload, format="json")
    assert done.status_code == 201 and stock_of(product) == 18
    movement = InventoryMovement.objects.get(movement_type="ADJUSTMENT")
    assert (movement.quantity_delta, movement.balance_before, movement.balance_after) == (-2, 20, 18)
    assert (movement.user, movement.reason) == (accountant, "2 bottles broken")
    from inventory.models import StockAdjustmentLine
    damage = StockAdjustmentLine.objects.get(adjustment__kind="DAMAGE")
    assert (damage.damaged_quantity, damage.selling_price_at_damage, damage.damage_value,
            damage.average_cost_at_damage, damage.inventory_cost_damage_value, damage.movement) == (
                2, 4500, 9000, 1000, 2000, movement)
    assert InventoryMovement.objects.filter(product=product).count() == 2  # opening line still there
    history = client.get(f"/api/v1/stock/movements/?product={product.pk}").data["results"]
    assert [m["movement_type"] for m in history] == ["ADJUSTMENT", "OPENING"]
    negative = client.post("/api/v1/stock/adjustments/", count_payload([(product, -1)], reason="oops"), format="json")
    assert negative.status_code == 400


def test_product_rules(owner, make_product):
    client = client_for(owner)
    created = client.post("/api/v1/products/", {"name": "  Konyagi   ndogo ", "selling_price": "4500", "base_unit": "Bottle",
                                                "package_size": "200ml"}, format="json")
    assert created.status_code == 201 and created.data["name"] == "Konyagi ndogo" and created.data["sku"].startswith("P")
    assert "barcode" not in created.data  # barcodes were removed (owner's decision, 21 Oct 2026)
    assert client.post("/api/v1/products/", {"name": "Bad", "selling_price": "-5"}, format="json").status_code == 400
    pk = created.data["id"]
    assert client.patch(f"/api/v1/products/{pk}/", {"selling_price": "5000"}, format="json").status_code == 200
    log = AuditLog.objects.get(action="product.price_changed")
    assert (log.before, log.after, log.actor) == ({"selling_price": "4500.00"}, {"selling_price": "5000.00"}, owner)
    assert client.delete(f"/api/v1/products/{pk}/").status_code == 405  # FR-PROD-06: deactivate, never delete
    assert client.patch(f"/api/v1/products/{pk}/", {"is_active": False}, format="json").status_code == 200
    assert Product.objects.filter(pk=pk).exists()


def test_search_by_name_code_and_size(cashier, make_product):
    konyagi = make_product("Konyagi ndogo", package_size="200ml")
    make_product("Konyagi kubwa", package_size="750ml")
    make_product("Serengeti", is_active=False)
    client = client_for(cashier)
    names = lambda q: [p["name"] for p in client.get(f"/api/v1/products/?search={q}").data["results"]]
    assert names("konyagi") == ["Konyagi kubwa", "Konyagi ndogo"]
    assert names("kony 750") == ["Konyagi kubwa"]
    assert names(konyagi.sku) == ["Konyagi ndogo"]
    assert names("serengeti") == []  # products that are switched off are not offered to cashiers


def test_opening_count_list_query_count_does_not_grow_with_sheets(owner, shop, make_product):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    not_live(shop)
    boss, product = client_for(owner), make_product("A")

    def add_rejected_sheet():
        sheet = boss.post("/api/v1/stock/opening-counts/", sheet_payload([(product, 3)]), format="json").data["id"]
        boss.post(f"/api/v1/stock/opening-counts/{sheet}/review/", {"approve": False, "note": "Recount"}, format="json")

    def queries():
        with CaptureQueriesContext(connection) as ctx:
            assert boss.get("/api/v1/stock/opening-counts/").status_code == 200
        return len(ctx)

    add_rejected_sheet()
    one = queries()
    for _ in range(4):
        add_rejected_sheet()
    assert queries() == one


def test_branch_is_looked_up_once_per_request(owner, shop):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    boss = client_for(owner)
    with CaptureQueriesContext(connection) as ctx:
        assert boss.get("/api/v1/day/current/").status_code == 200
    assert sum('FROM "core_branch"' in q["sql"] for q in ctx) <= 1
