"""Colour-coded stock levels: healthy, low, critical, out of stock; per-product levels; alerts on getting worse."""
import uuid
from decimal import Decimal

import pytest

from catalog.stock_levels import CRITICAL, IN_STOCK, LOW_STOCK, OUT_OF_STOCK, stock_status
from inventory.models import StockAlert

from .conftest import client_for, sell, start_shift


@pytest.mark.parametrize("quantity, expected", [
    (15, IN_STOCK), (11, IN_STOCK), (10, LOW_STOCK), (6, LOW_STOCK), (5, CRITICAL), (1, CRITICAL), (0, OUT_OF_STOCK),
])
def test_example_from_the_brief_low_10_critical_5(quantity, expected):
    assert stock_status(Decimal(quantity), Decimal("10"), Decimal("5")) == expected


def test_no_levels_set_means_healthy_until_empty():
    assert stock_status(Decimal("1"), Decimal("0"), Decimal("0")) == IN_STOCK
    assert stock_status(Decimal("0"), Decimal("0"), Decimal("0")) == OUT_OF_STOCK


def test_without_a_critical_level_low_goes_straight_to_out_of_stock():
    assert stock_status(Decimal("1"), Decimal("10"), Decimal("0")) == LOW_STOCK


def test_owner_sets_both_levels_and_critical_must_be_below_low(owner, make_product):
    product = make_product()
    client = client_for(owner)
    url = f"/api/v1/products/{product.pk}/"
    assert client.patch(url, {"reorder_point": "10", "critical_point": "5"}, format="json").status_code == 200
    product.refresh_from_db()
    assert (product.reorder_point, product.critical_point) == (10, 5)

    same = client.patch(url, {"critical_point": "10"}, format="json")
    assert same.status_code == 400 and "lower than the low-stock" in str(same.data)
    no_low = client.patch(url, {"reorder_point": "0"}, format="json")
    assert no_low.status_code == 400 and "critical_point" in str(no_low.data)
    assert client.patch(url, {"reorder_point": "0", "critical_point": "0"}, format="json").status_code == 200


def test_cashier_cannot_set_levels_or_see_them(cashier, make_product):
    product = make_product(stock=3, reorder_point=Decimal("10"), critical_point=Decimal("5"))
    client = client_for(cashier)
    assert client.patch(f"/api/v1/products/{product.pk}/", {"reorder_point": "1"}, format="json").status_code == 403
    row = client.get(f"/api/v1/products/{product.pk}/").data
    assert row["stock_status"] == CRITICAL and "critical_point" not in row and "reorder_point" not in row


def test_sales_take_a_product_through_each_level_and_alert_once_per_worsening(cashier, owner, shop, make_product):
    product = make_product(stock=12, reorder_point=Decimal("10"), critical_point=Decimal("5"))
    till = client_for(cashier)
    start_shift(till)

    def status():
        return client_for(owner).get(f"/api/v1/products/{product.pk}/").data["stock_status"]

    assert status() == IN_STOCK
    assert sell(till, [(product, 1)], [(shop.cash, 4500)]).status_code == 201  # 11: still healthy
    assert status() == IN_STOCK and StockAlert.objects.count() == 0
    sell(till, [(product, 1)], [(shop.cash, 4500)])  # 10
    assert status() == LOW_STOCK
    sell(till, [(product, 1)], [(shop.cash, 4500)])  # 9: still low, no new alert
    sell(till, [(product, 4)], [(shop.cash, 18000)])  # 5
    assert status() == CRITICAL
    sell(till, [(product, 5)], [(shop.cash, 22500)])  # 0
    assert status() == OUT_OF_STOCK
    assert [a.status_after for a in StockAlert.objects.order_by("id")] == [LOW_STOCK, CRITICAL, OUT_OF_STOCK]

    # Reading the products again never creates alerts.
    for _ in range(3):
        status()
    assert StockAlert.objects.count() == 3


def test_delivery_makes_it_healthy_again_without_an_alert(accountant, owner, make_product):
    product = make_product(stock=2, reorder_point=Decimal("10"))
    before = StockAlert.objects.count()
    response = client_for(accountant).post("/api/v1/stock/receipts/", {
        "request_key": str(uuid.uuid4()), "lines": [{"product": product.pk, "quantity": "20", "unit_cost": "1000"}]}, format="json")
    assert response.status_code == 201, response.data
    assert StockAlert.objects.count() == before
    assert client_for(owner).get(f"/api/v1/products/{product.pk}/").data["stock_status"] == IN_STOCK


def test_count_correction_down_to_critical_raises_an_alert(accountant, make_product):
    product = make_product(stock=20, reorder_point=Decimal("10"), critical_point=Decimal("5"))
    response = client_for(accountant).post("/api/v1/stock/adjustments/", {
        "request_key": str(uuid.uuid4()), "reason": "Monthly count", "lines": [{"product": product.pk, "quantity": "4"}]}, format="json")
    assert response.status_code == 201, response.data
    alert = StockAlert.objects.get(product=product)
    assert (alert.status_before, alert.status_after, alert.quantity) == (IN_STOCK, CRITICAL, 4)


def test_alert_feed_only_returns_alerts_newer_than_the_last_one_shown(owner, cashier, accountant, make_product):
    product = make_product(stock=20, reorder_point=Decimal("10"))
    office = client_for(accountant)
    start = client_for(owner).get("/api/v1/stock/alerts/").data["latest_id"]
    office.post("/api/v1/stock/adjustments/", {"request_key": str(uuid.uuid4()), "reason": "Count",
                                               "lines": [{"product": product.pk, "quantity": "8"}]}, format="json")
    feed = client_for(owner).get(f"/api/v1/stock/alerts/?after={start}").data
    assert [(a["product"], a["status"], a["status_label"], a["current_status"]) for a in feed["results"]] == [
        (product.pk, LOW_STOCK, "Low stock", LOW_STOCK)]
    assert client_for(owner).get(f"/api/v1/stock/alerts/?after={feed['latest_id']}").data["results"] == []
    assert client_for(cashier).get("/api/v1/stock/alerts/").status_code == 403


def test_dashboard_counts_and_attention_list(owner, cashier, make_product):
    healthy = make_product("Healthy", stock=50, reorder_point=Decimal("10"))
    low = make_product("Low", stock=8, reorder_point=Decimal("10"), critical_point=Decimal("3"))
    critical = make_product("Critical", stock=2, reorder_point=Decimal("10"), critical_point=Decimal("3"))
    empty = make_product("Empty", stock=0)
    make_product("Switched off", stock=0, is_active=False)
    client = client_for(owner)

    counts = client.get("/api/v1/products/stock-levels/").data
    assert counts["counts"] == {IN_STOCK: 1, LOW_STOCK: 1, CRITICAL: 1, OUT_OF_STOCK: 1} and counts["total"] == 4

    worst_first = client.get("/api/v1/products/?stock_status=ATTENTION").data["results"]
    assert [r["id"] for r in worst_first] == [empty.pk, critical.pk, low.pk]
    only_low = client.get("/api/v1/products/?stock_status=LOW_STOCK").data["results"]
    assert [r["id"] for r in only_low] == [low.pk]
    assert healthy.pk not in [r["id"] for r in worst_first]

    table = client.get("/api/v1/products/table/?stock_status=CRITICAL,OUT_OF_STOCK&active=true").data
    assert sorted(r["id"] for r in table["results"]) == sorted([critical.pk, empty.pk])
    assert {r["stock_status"] for r in table["results"]} == {CRITICAL, OUT_OF_STOCK}

    assert client_for(cashier).get("/api/v1/products/stock-levels/").status_code == 403


def test_low_stock_report_includes_critical_with_its_label(owner, make_product):
    make_product("Critical", stock=2, reorder_point=Decimal("10"), critical_point=Decimal("3"))
    make_product("Fine", stock=50, reorder_point=Decimal("10"))
    rows = client_for(owner).get("/api/v1/reports/low-stock/").data["rows"]
    assert [(r["product"], r["status"]) for r in rows] == [("Critical", "Critical stock")]
