"""Sale completion, stock deduction, payments, duplicates and cancellation (SRS AT-01..AT-09, AT-14)."""
import uuid
from decimal import Decimal

import pytest

from catalog.models import ProductUnit
from core.models import AuditLog, ImmutableError
from inventory.models import InventoryMovement
from sales.models import Payment, Sale, SaleItem

from .conftest import client_for, sale_payload, sell, start_shift, stock_of


@pytest.fixture
def till(cashier):
    client = client_for(cashier)
    start_shift(client)
    return client


def test_at01_normal_sale_deducts_stock_once(till, shop, make_product):
    product = make_product(price="4500", stock=48)
    response = sell(till, [(product, 5)], [(shop.cash, 22500)])
    assert response.status_code == 201, response.data
    assert response.data["total"] == "22500.00" and response.data["change_due"] == "0.00"
    assert response.data["items"][0]["line_total"] == "22500.00"
    assert response.data["receipt_number"].startswith("MB-")
    assert stock_of(product) == 43
    movements = InventoryMovement.objects.filter(product=product, movement_type="SALE")
    assert movements.count() == 1
    assert (movements[0].quantity_delta, movements[0].balance_before, movements[0].balance_after) == (-5, 48, 43)
    assert Sale.objects.count() == 1
    assert AuditLog.objects.filter(action="sale.completed").count() == 1


def test_at02_multiple_products_deduct_only_their_own_quantities(till, shop, make_product):
    a, b, untouched = make_product("A", "1000", 10), make_product("B", "2500", 10), make_product("C", "999", 10)
    response = sell(till, [(a, 2), (b, 3)], [(shop.cash, 10000)])
    assert response.status_code == 201
    assert response.data["total"] == "9500.00" and response.data["change_due"] == "500.00"
    assert (stock_of(a), stock_of(b), stock_of(untouched)) == (8, 7, 10)


def test_at03_low_stock_status_after_sale(till, owner, shop, make_product):
    product = make_product(stock=8, reorder_point=Decimal("10"))
    assert sell(till, [(product, 1)], [(shop.cash, 4500)]).status_code == 201
    row = client_for(owner).get(f"/api/v1/products/{product.pk}/").data
    assert row["stock_on_hand"] == "7.000" and row["stock_status"] == "LOW_STOCK"


@pytest.mark.parametrize("stock,wanted", [(0, 1), (4, 6)])
def test_at04_at05_overselling_is_blocked(till, shop, make_product, stock, wanted):
    product = make_product(stock=stock)
    response = sell(till, [(product, wanted)], [(shop.cash, 4500 * wanted)])
    assert response.status_code == 409 and response.data["code"] == "insufficient_stock"
    assert "Not enough stock" in response.data["message"]
    assert stock_of(product) == stock and Sale.objects.count() == 0


def test_at06_verified_pack_conversion(till, shop, make_product):
    product = make_product(price="1000", stock=30)
    carton = ProductUnit.objects.create(product=product, name="Carton", factor=12, selling_price=11000, is_verified=False)
    payload = sale_payload([(product, 2)], [(shop.cash, 22000)])
    payload["items"][0]["unit"] = carton.pk
    blocked = till.post("/api/v1/sales/", payload, format="json")
    assert blocked.status_code == 400 and blocked.data["code"] == "unit_unverified"  # FR-PROD-05
    carton.is_verified = True
    carton.save()
    payload["request_key"] = str(uuid.uuid4())
    done = till.post("/api/v1/sales/", payload, format="json")
    assert done.status_code == 201 and done.data["total"] == "22000.00"
    assert stock_of(product) == 6  # 30 - 2 x 12


def test_at07_duplicate_request_creates_one_sale(till, shop, make_product):
    product = make_product(stock=10)
    key = uuid.uuid4()
    first = sell(till, [(product, 2)], [(shop.cash, 9000)], key)
    second = sell(till, [(product, 2)], [(shop.cash, 9000)], key)
    assert (first.status_code, second.status_code) == (201, 200)
    assert second.data["id"] == first.data["id"] and second.data["already_saved"] is True
    assert Sale.objects.count() == 1 and stock_of(product) == 8
    assert InventoryMovement.objects.filter(movement_type="SALE").count() == 1


def test_at09_failure_during_commit_leaves_nothing_behind(till, shop, make_product, monkeypatch):
    product = make_product(stock=10)

    def boom(*args, **kwargs):
        raise RuntimeError("simulated crash")

    monkeypatch.setattr("sales.services.audit", boom)
    till.raise_request_exception = False
    response = sell(till, [(product, 2)], [(shop.cash, 9000)])
    assert response.status_code == 500
    assert "simulated" not in str(response.data)  # internal details are not shown to the user
    assert Sale.objects.count() == 0 and SaleItem.objects.count() == 0 and Payment.objects.count() == 0
    assert stock_of(product) == 10 and not InventoryMovement.objects.filter(movement_type="SALE").exists()


def test_at14_split_payment_only_cash_part_counts_as_cash(till, shop, make_product):
    product = make_product(price="100000", stock=5)
    response = sell(till, [(product, 1)], [(shop.cash, 40000), (shop.momo, 60000)])
    assert response.status_code == 201
    figures = till.get("/api/v1/day/current/").data["shift_figures"]
    assert figures["cash_sales"] == "40000.00" and figures["sales_total"] == "100000.00"
    by_code = {p["code"]: p["amount"] for p in figures["payments"]}
    assert by_code == {"cash": "40000.00", "mobile-money": "60000.00", "bank": "0.00"}


def test_cash_overpayment_gives_change_and_keeps_only_the_total(till, shop, make_product):
    product = make_product(price="4500", stock=5)
    response = sell(till, [(product, 1)], [(shop.cash, 10000)])
    assert response.data["change_due"] == "5500.00"
    payment = Payment.objects.get()
    assert (payment.tendered, payment.amount) == (10000, 4500)


def test_payment_validation_messages(till, shop, make_product):
    product = make_product(price="4500", stock=5)
    under = sell(till, [(product, 1)], [(shop.cash, 4000)])
    assert under.status_code == 400 and under.data["code"] == "underpaid" and "500 less" in under.data["message"]
    over = sell(till, [(product, 1)], [(shop.momo, 5000)])
    assert over.status_code == 400 and over.data["code"] == "non_cash_over"
    zero_qty = sell(till, [(product, 0)], [(shop.cash, 4500)])
    assert zero_qty.status_code == 400 and zero_qty.data["message"] == "Enter a quantity greater than zero."
    empty = till.post("/api/v1/sales/", {"request_key": str(uuid.uuid4()), "items": [], "payments": []}, format="json")
    assert empty.status_code == 400 and empty.data["message"] == "Add at least one product to the sale."
    assert Sale.objects.count() == 0


def test_split_payment_can_be_switched_off(till, shop, make_product):
    shop.cfg.split_payments_enabled = False
    shop.cfg.save()
    product = make_product(price="10000", stock=5)
    response = sell(till, [(product, 1)], [(shop.cash, 4000), (shop.momo, 6000)])
    assert response.status_code == 400 and response.data["code"] == "split_disabled"


def test_inactive_payment_method_is_refused(till, shop, make_product):
    shop.bank.is_active = False
    shop.bank.save()
    product = make_product(stock=5)
    assert sell(till, [(product, 1)], [(shop.bank, 4500)]).data["code"] == "method_inactive"


def test_price_always_comes_from_the_server(till, shop, make_product):
    product = make_product(price="4500", stock=5)
    payload = sale_payload([(product, 1)], [(shop.cash, 4500)])
    payload["items"][0]["unit_price"] = "1"
    payload["total"] = "1"
    response = till.post("/api/v1/sales/", payload, format="json")
    assert response.status_code == 201 and response.data["total"] == "4500.00"


def test_product_without_price_or_inactive_cannot_be_sold(till, shop, make_product):
    free = make_product(price="0", stock=5)
    assert sell(till, [(free, 1)], [(shop.cash, 1)]).data["code"] == "no_price"
    off = make_product(stock=5, is_active=False)
    assert sell(till, [(off, 1)], [(shop.cash, 4500)]).data["code"] == "product_inactive"


def test_no_sale_without_an_open_shift(cashier, shop, make_product):
    product = make_product(stock=5)
    response = sell(client_for(cashier), [(product, 1)], [(shop.cash, 4500)])
    assert response.status_code == 409 and response.data["message"] == "Start your day before making a sale."


def test_receipt_numbers_are_unique_and_sequential(till, shop, make_product):
    product = make_product(stock=10)
    numbers = [sell(till, [(product, 1)], [(shop.cash, 4500)]).data["receipt_number"] for _ in range(3)]
    assert len(set(numbers)) == 3
    assert [n[-4:] for n in numbers] == ["0001", "0002", "0003"]


def test_completed_sale_cannot_be_edited_or_deleted(till, owner, shop, make_product):
    product = make_product(stock=5)
    sale_id = sell(till, [(product, 1)], [(shop.cash, 4500)]).data["id"]
    for client in (till, client_for(owner)):
        assert client.patch(f"/api/v1/sales/{sale_id}/", {"total": "1"}, format="json").status_code == 405
        assert client.put(f"/api/v1/sales/{sale_id}/", {"total": "1"}, format="json").status_code == 405
        assert client.delete(f"/api/v1/sales/{sale_id}/").status_code == 405
    sale = Sale.objects.get(pk=sale_id)
    with pytest.raises(ImmutableError):
        sale.delete()
    item = sale.items.first()
    item.quantity = 99
    with pytest.raises(ImmutableError):
        item.save()
    with pytest.raises(ImmutableError):
        InventoryMovement.objects.first().delete()


def test_void_needs_back_office_and_a_reason_and_restores_stock(till, accountant, shop, make_product):
    product = make_product(stock=10)
    sale_id = sell(till, [(product, 3)], [(shop.cash, 13500)]).data["id"]
    assert till.post(f"/api/v1/sales/{sale_id}/void/", {"reason": "customer changed mind"}, format="json").status_code == 403
    office = client_for(accountant)
    assert office.post(f"/api/v1/sales/{sale_id}/void/", {"reason": " "}, format="json").status_code == 400
    done = office.post(f"/api/v1/sales/{sale_id}/void/", {"reason": "customer changed mind"}, format="json")
    assert done.status_code == 200 and done.data["status"] == "VOIDED" and done.data["void_reason"] == "customer changed mind"
    again = office.post(f"/api/v1/sales/{sale_id}/void/", {"reason": "customer changed mind"}, format="json")
    assert again.status_code == 200
    assert stock_of(product) == 10
    assert InventoryMovement.objects.filter(movement_type="VOID").count() == 1  # not restored twice
    assert set(Payment.objects.values_list("status", flat=True)) == {"REVERSED"}
    assert Sale.objects.count() == 1  # the sale is kept, marked cancelled
    figures = till.get("/api/v1/day/current/").data["shift_figures"]
    assert figures["sales_total"] == "0.00" and figures["voided_total"] == "13500.00" and figures["cash_sales"] == "0.00"
    assert AuditLog.objects.filter(action="sale.voided", reason="customer changed mind").count() == 1


def test_stock_ledger_always_adds_up_to_the_balance(till, accountant, shop, make_product):
    from django.db.models import Sum

    product = make_product(stock=20)
    first = sell(till, [(product, 4)], [(shop.cash, 18000)]).data["id"]
    sell(till, [(product, 5)], [(shop.cash, 22500)])
    client_for(accountant).post(f"/api/v1/sales/{first}/void/", {"reason": "wrong item"}, format="json")
    ledger = InventoryMovement.objects.filter(product=product).aggregate(total=Sum("quantity_delta"))["total"]
    assert ledger == stock_of(product) == 15


def test_owner_manages_payment_methods_but_one_must_stay_on(owner, accountant, cashier, shop):
    boss = client_for(owner)
    added = boss.post("/api/v1/payment-methods/", {"code": "airtel-money", "name": "Airtel Money", "reference_label": "Transaction ID"}, format="json")
    assert added.status_code == 201
    assert client_for(accountant).patch(f"/api/v1/payment-methods/{shop.bank.pk}/", {"is_active": False}, format="json").status_code == 403
    for method in (shop.momo, shop.bank, added.data["id"]):
        pk = getattr(method, "pk", method)
        assert boss.patch(f"/api/v1/payment-methods/{pk}/", {"is_active": False}, format="json").status_code == 200
    last = boss.patch(f"/api/v1/payment-methods/{shop.cash.pk}/", {"is_active": False}, format="json")
    assert last.status_code == 409 and last.data["code"] == "last_method"
    assert [m["name"] for m in client_for(cashier).get("/api/v1/payment-methods/").data] == ["Cash"]  # cashiers see only what is on
    assert len(boss.get("/api/v1/payment-methods/").data) == 4
    assert AuditLog.objects.filter(action__startswith="payment_method.").count() == 4