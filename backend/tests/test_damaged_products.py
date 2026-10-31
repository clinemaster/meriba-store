"""Damage valuation, stock integrity, register, reports and reversals."""
import uuid
from datetime import date
from decimal import Decimal

import pytest
from django.db import connection

from inventory.models import InventoryMovement, StockAdjustment, StockAdjustmentLine
from sales.models import Sale

from .conftest import client_for, stock_of


def damage_payload(lines, key=None, **extra):
    return {
        "request_key": str(key or uuid.uuid4()),
        "reason": "Broken in storage",
        "remarks": "Found during shelf check",
        "evidence_reference": "PHOTO-17",
        "lines": [{"product": product.pk, "quantity": str(quantity)} for product, quantity in lines],
        **extra,
    }


def test_damage_records_multiple_products_and_price_snapshots(owner, accountant, make_product, set_today):
    set_today(date(2026, 10, 31))
    first = make_product("Konyagi", price="4500", stock=20)
    second = make_product("Serengeti", price="3000", stock=10, cost_price=Decimal("1200"), average_cost=Decimal("1200"))
    office = client_for(accountant)

    response = office.post("/api/v1/stock/damaged/", damage_payload([(first, 2), (second, 3)]), format="json")
    assert response.status_code == 201, response.data
    assert (response.data["products"], response.data["damaged_quantity"], response.data["damage_value"]) == (2, "5.000", "18000.00")
    assert response.data["inventory_cost_value"] == "5600.00"
    assert (stock_of(first), stock_of(second)) == (18, 7)
    assert Sale.objects.count() == 0

    lines = {line.product_id: line for line in StockAdjustmentLine.objects.filter(adjustment__kind=StockAdjustment.Kind.DAMAGE)}
    assert (lines[first.pk].quantity_before, lines[first.pk].damaged_quantity, lines[first.pk].quantity_counted) == (20, 2, 18)
    assert (lines[first.pk].selling_price_at_damage, lines[first.pk].damage_value, lines[first.pk].inventory_cost_damage_value) == (4500, 9000, 2000)
    assert (lines[second.pk].selling_price_at_damage, lines[second.pk].damage_value, lines[second.pk].inventory_cost_damage_value) == (3000, 9000, 3600)
    assert all(line.movement_id for line in lines.values())

    owner_client = client_for(owner)
    changed = owner_client.patch(f"/api/v1/products/{first.pk}/", {"selling_price": "5000"}, format="json")
    assert changed.status_code == 200
    lines[first.pk].refresh_from_db()
    assert (lines[first.pk].selling_price_at_damage, lines[first.pk].damage_value) == (4500, 9000)

    dated = "date_from=2026-10-31&date_to=2026-10-31"
    register = office.get(f"/api/v1/stock/damaged/?{dated}&product=Konyagi").data
    assert register["count"] == 1
    assert register["summary"]["products"] == 1
    assert Decimal(register["summary"]["damaged_quantity"]) == 2
    assert Decimal(register["summary"]["damage_value"]) == 9000
    assert register["results"][0]["reference"] == response.data["reference"]
    assert register["results"][0]["movement"] == lines[first.pk].movement_id
    assert Decimal(office.get(f"/api/v1/reports/damage-daily/?{dated}").data["rows"][0]["damage_value"]) == 18000
    assert Decimal(office.get(f"/api/v1/reports/damage-monthly/?{dated}").data["rows"][0]["damage_value"]) == 18000
    assert len(office.get(f"/api/v1/reports/damage-by-product/?{dated}").data["rows"]) == 2
    assert office.get(f"/api/v1/reports/damage-by-branch/?{dated}").data["rows"][0]["branch"] == "MERIBA Main Branch"
    export = office.get(f"/api/v1/stock/damaged/?{dated}&download=xlsx")
    assert export.status_code == 200 and "spreadsheetml" in export["Content-Type"]


def test_damage_rejects_bad_quantities_and_duplicate_request_is_idempotent(accountant, cashier, make_product):
    product = make_product(stock=5)
    office = client_for(accountant)
    key = uuid.uuid4()
    payload = damage_payload([(product, 3)], key=key)

    assert client_for(cashier).post("/api/v1/stock/damaged/", payload, format="json").status_code == 403
    too_much = office.post("/api/v1/stock/damaged/", damage_payload([(product, 6)]), format="json")
    assert too_much.status_code == 409 and too_much.data["code"] == "insufficient_stock"
    zero = office.post("/api/v1/stock/damaged/", damage_payload([(product, 0)]), format="json")
    assert zero.status_code == 400
    assert stock_of(product) == 5
    assert not StockAdjustment.objects.filter(kind=StockAdjustment.Kind.DAMAGE).exists()

    first = office.post("/api/v1/stock/damaged/", payload, format="json")
    retry = office.post("/api/v1/stock/damaged/", payload, format="json")
    assert first.status_code == 201 and retry.status_code == 200 and retry.data["already_saved"] is True
    assert stock_of(product) == 2
    assert InventoryMovement.objects.filter(product=product).count() == 2
    generic_damage = office.post(
        "/api/v1/stock/adjustments/",
        {"request_key": str(uuid.uuid4()), "reason": "broke", "kind": "DAMAGE", "lines": [{"product": product.pk, "quantity": "1"}]},
        format="json",
    )
    assert generic_damage.status_code == 400


def test_damage_reversal_is_owner_only_once_and_keeps_original_register_entry(owner, accountant, make_product):
    product = make_product(price="2500", stock=8)
    office = client_for(accountant)
    original = office.post("/api/v1/stock/damaged/", damage_payload([(product, 2)]), format="json")
    assert original.status_code == 201 and stock_of(product) == 6
    body = {"request_key": str(uuid.uuid4()), "reason": "Entered against the wrong delivery"}
    assert office.post(f"/api/v1/stock/damaged/{original.data['id']}/reverse/", body, format="json").status_code == 403

    owner_client = client_for(owner)
    reversal = owner_client.post(f"/api/v1/stock/damaged/{original.data['id']}/reverse/", body, format="json")
    assert reversal.status_code == 201 and stock_of(product) == 8
    assert owner_client.post(f"/api/v1/stock/damaged/{original.data['id']}/reverse/",
                             {"request_key": str(uuid.uuid4()), "reason": "Second reversal"}, format="json").status_code == 409
    assert StockAdjustment.objects.filter(reversal_of_id=original.data["id"]).count() == 1
    assert InventoryMovement.objects.filter(product=product).count() == 3

    register = owner_client.get("/api/v1/stock/damaged/?date_from=2026-01-01&date_to=2026-12-31").data
    row = next(item for item in register["results"] if item["reference"] == original.data["reference"])
    assert row["status"] == "Reversed"
    assert Decimal(register["summary"]["damage_value"]) == 0


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_damage_request_deducts_stock_once(owner, make_product):
    import threading

    product = make_product(stock=10)
    key = uuid.uuid4()
    payload = damage_payload([(product, 6)], key=key)
    barrier = threading.Barrier(2)
    results = [None, None]

    def worker(index):
        try:
            barrier.wait(timeout=10)
            results[index] = client_for(owner).post("/api/v1/stock/damaged/", payload, format="json")
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert all(result is not None for result in results)
    assert sorted(result.status_code for result in results) == [200, 201]
    assert stock_of(product) == 4
    assert StockAdjustment.objects.filter(kind=StockAdjustment.Kind.DAMAGE).count() == 1
    assert InventoryMovement.objects.filter(product=product).count() == 2


@pytest.mark.django_db(transaction=True)
def test_concurrent_damage_requests_cannot_overdraw_stock(accountant, make_product):
    import threading

    product = make_product(stock=10)
    payloads = [damage_payload([(product, 7)]), damage_payload([(product, 7)])]
    barrier = threading.Barrier(2)
    results = [None, None]

    def worker(index):
        try:
            barrier.wait(timeout=10)
            results[index] = client_for(accountant).post("/api/v1/stock/damaged/", payloads[index], format="json")
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert all(result is not None for result in results)
    assert sorted(result.status_code for result in results) == [201, 409]
    assert stock_of(product) == 3
    assert StockAdjustment.objects.filter(kind=StockAdjustment.Kind.DAMAGE).count() == 1
    assert InventoryMovement.objects.filter(product=product).count() == 2