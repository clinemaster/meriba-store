"""Product table, selling units, volume, weighted-average cost and gross profit
(product table enhancement, 12 Oct 2026; acceptance points 1-12)."""
import uuid
from datetime import date
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction

from catalog.models import Product, ProductUnit
from core.models import AuditLog
from finance.models import GoodsReceiptLine
from sales.models import SaleItem

from .conftest import client_for, sale_payload, sell, start_shift, stock_of

D1, D2 = date(2026, 11, 2), date(2026, 11, 3)


def table(client, **params):
    response = client.get("/api/v1/products/table/", params)
    assert response.status_code == 200, response.data
    return response.data


def row(client, product, **params):
    return next(r for r in table(client, page_size=500, **params)["results"] if r["id"] == product.pk)


def receive(client, product, quantity, unit_cost=None, **extra):
    body = {"request_key": str(uuid.uuid4()), "lines": [{"product": product.pk, "quantity": str(quantity), "unit_cost": unit_cost}]}
    response = client.post("/api/v1/stock/receipts/", body | extra, format="json")
    assert response.status_code == 201, response.data
    return response.data


def refund(client, sale, quantity, method, restock=True):
    return client.post(f"/api/v1/sales/{sale['id']}/refund/", {
        "request_key": str(uuid.uuid4()), "reason": "Customer brought it back", "method": method.pk,
        "lines": [{"sale_item": sale["items"][0]["id"], "quantity": str(quantity), "restock": restock}]}, format="json")


def close(client, shift_id, counted):
    return client.post(f"/api/v1/shifts/{shift_id}/close/", {"counted_cash": str(counted), "note": "count"}, format="json")


# --- 1, 2. Sold By is a validated list; volume is a positive whole number or blank ---------------

def test_sold_by_accepts_only_the_approved_units(owner):
    client = client_for(owner)
    for unit in ("Crate", "Carton", "Box", "Bottle", "Pack"):
        made = client.post("/api/v1/products/", {"name": f"Item by {unit}", "selling_price": "1000", "base_unit": unit}, format="json")
        assert made.status_code == 201 and made.data["base_unit"] == unit, made.data
    for bad in ("Sack", "bottle", "Single", "", "Crate; DROP TABLE"):
        refused = client.post("/api/v1/products/", {"name": "Bad unit", "selling_price": "1000", "base_unit": bad}, format="json")
        assert refused.status_code == 400 and "base_unit" in refused.data["errors"], (bad, refused.data)
    assert "Crate, Carton, Box, Bottle, Pack" in client.post(
        "/api/v1/products/", {"name": "Bad unit", "selling_price": "1000", "base_unit": "Sack"}, format="json").data["message"]
    assert not Product.objects.filter(name="Bad unit").exists()
    # the database itself refuses an unapproved unit, even if the API were bypassed
    with pytest.raises(IntegrityError), transaction.atomic():
        Product.objects.create(sku="X1", name="Direct", selling_price=1, base_unit="Sack")
    assert table(client)["sold_by_options"] == ["Crate", "Carton", "Box", "Bottle", "Pack"]


def test_volume_is_per_bottle_in_millilitres_and_may_be_blank(owner):
    client = client_for(owner)
    made = client.post("/api/v1/products/", {"name": "Konyagi ndogo", "selling_price": "4500", "volume_ml": 200}, format="json")
    assert made.status_code == 201 and made.data["volume_ml"] == 200 and made.data["package_size"] == "200ml"
    assert str(Product.objects.get(pk=made.data["id"])) == "Konyagi ndogo 200ml"
    blank = client.post("/api/v1/products/", {"name": "Soda Take away", "selling_price": "11000", "base_unit": "Carton"}, format="json")
    assert blank.status_code == 201 and blank.data["volume_ml"] is None
    for bad in (0, -5, "abc", 2.5):
        assert client.post("/api/v1/products/", {"name": "x", "selling_price": "1", "volume_ml": bad}, format="json").status_code == 400, bad
    # a crate keeps the volume of ONE bottle; how many bottles it holds is configured separately
    crate = client.post("/api/v1/products/", {"name": "Kilimanjaro", "selling_price": "34000", "base_unit": "Crate",
                                              "volume_ml": 500, "bottles_per_unit": 20}, format="json")
    assert (crate.data["volume_ml"], crate.data["bottles_per_unit"], crate.data["base_unit"]) == (500, 20, "Crate")
    other = client.post("/api/v1/products/", {"name": "Safari", "selling_price": "36000", "base_unit": "Crate", "bottles_per_unit": 25}, format="json")
    assert other.data["bottles_per_unit"] == 25  # not every crate holds the same number
    wrong = client.post("/api/v1/products/", {"name": "y", "selling_price": "1", "base_unit": "Bottle", "bottles_per_unit": 12}, format="json")
    assert wrong.status_code == 400 and "bottles_per_unit" in wrong.data["errors"]
    cleared = client.patch(f"/api/v1/products/{made.data['id']}/", {"volume_ml": None}, format="json")
    assert cleared.data["volume_ml"] is None and cleared.data["package_size"] == ""


# --- 4. Package conversion: a crate containing 12 bottles ----------------------------------------

def test_crate_of_12_bottles_converts_for_stock_and_keeps_history(owner, accountant, cashier, shop, make_product):
    bottle = make_product("Safari Lager", "3000", 60)
    office, boss = client_for(accountant), client_for(owner)
    url = f"/api/v1/products/{bottle.pk}/units/"
    assert office.post(url, {"name": "Sack", "factor": "12", "selling_price": "34000"}, format="json").status_code == 400
    assert office.post(url, {"name": "Bottle", "factor": "12", "selling_price": "34000"}, format="json").data["code"] == "same_unit"
    crate = office.post(url, {"name": "Crate", "factor": "12", "selling_price": "34000"}, format="json")
    assert crate.status_code == 201 and crate.data["is_verified"] is False
    assert office.post(url, {"name": "Crate", "factor": "24", "selling_price": "1"}, format="json").data["code"] == "unit_exists"

    till = client_for(cashier)
    start_shift(till)
    payload = lambda qty: sale_payload([(bottle, qty)], [(shop.cash, 34000 * qty)]) | {
        "items": [{"product": bottle.pk, "quantity": str(qty), "unit": crate.data["id"]}]}
    assert till.post("/api/v1/sales/", payload(1), format="json").data["code"] == "unit_unverified"
    assert office.post(f"{url}{crate.data['id']}/verify/").status_code == 403  # Owner only
    assert boss.post(f"{url}{crate.data['id']}/verify/").data["is_verified"] is True
    sold = till.post("/api/v1/sales/", payload(2), format="json")
    assert sold.status_code == 201 and sold.data["total"] == "68000.00"
    assert stock_of(bottle) == 36  # 60 - 2 crates x 12 bottles
    line = SaleItem.objects.get()
    assert (line.unit_name, line.unit_factor, line.quantity, line.quantity_base) == ("Crate", 12, 2, 24)
    assert (line.unit_cost, line.cost_total) == (12000, 24000)  # 12 bottles at the average cost of 1,000

    # changing the package does not rewrite the past, and must be verified again before it can be sold
    changed = office.patch(f"{url}{crate.data['id']}/", {"factor": "24"}, format="json")
    assert changed.status_code == 200 and changed.data["factor"] == "24.000" and changed.data["is_verified"] is False
    line.refresh_from_db()
    assert (line.unit_factor, line.quantity_base) == (12, 24) and stock_of(bottle) == 36
    assert till.post("/api/v1/sales/", payload(1), format="json").data["code"] == "unit_unverified"
    actions = list(AuditLog.objects.filter(action__startswith="product.unit").order_by("id").values_list("action", flat=True))
    assert actions == ["product.unit_added", "product.unit_verified", "product.unit_changed"]
    log = AuditLog.objects.get(action="product.unit_changed")
    assert (log.before["factor"], log.after["factor"], log.after["is_verified"]) == ("12.000", "24.000", False)
    # in the table, sales are shown in the product's own unit (bottles): never crates and bottles mixed
    assert row(office, bottle)["sales"] == "24"


def test_sold_by_cannot_change_once_stock_or_sales_exist(owner, make_product):
    client = client_for(owner)
    fresh = client.post("/api/v1/products/", {"name": "New", "selling_price": "1000", "base_unit": "Bottle"}, format="json").data
    assert client.patch(f"/api/v1/products/{fresh['id']}/", {"base_unit": "Crate"}, format="json").status_code == 200
    stocked = make_product("Stocked", stock=10)
    refused = client.patch(f"/api/v1/products/{stocked.pk}/", {"base_unit": "Crate"}, format="json")
    assert refused.status_code == 400 and "cannot be changed" in refused.data["message"]
    stocked.refresh_from_db()
    assert stocked.base_unit == "Bottle"
    assert client.patch(f"/api/v1/products/{fresh['id']}/", {"bottles_per_unit": 12}, format="json").status_code == 200
    assert AuditLog.objects.filter(action="product.package_changed").count() == 2


# --- 5. Daily opening stock, incoming stock, sales and closing stock ------------------------------

def test_daily_stock_figures_and_carry_forward(cashier, accountant, shop, make_product, set_today):
    product = make_product("Konyagi", "4500", 100)
    till, office = client_for(cashier), client_for(accountant)
    set_today(D1)
    shift = start_shift(till)
    receive(office, product, 20, "1000")
    sell(till, [(product, 45)], [(shop.cash, 202500)])
    close(till, shift["id"], 202500)
    day1 = row(office, product, date=str(D1))
    # Total Stock = opening 100 + received 20; Closing = Total - Sales (AT-STK-01)
    assert (day1["opening_stock"], day1["incoming"], day1["total_item_stock"], day1["sales"], day1["closing_stock"]) == ("100", "20", "120", "45", "75")

    set_today(D2)
    shift = start_shift(till)
    sale = sell(till, [(product, 15)], [(shop.cash, 67500)]).data
    wrong = sell(till, [(product, 4)], [(shop.cash, 18000)]).data
    office.post(f"/api/v1/sales/{wrong['id']}/void/", {"reason": "rung up twice"}, format="json")       # cancelled: not a sale
    refund(office, sale, 2, shop.cash)                                                                   # 2 returned to the shelf
    office.post("/api/v1/stock/adjustments/", {"request_key": str(uuid.uuid4()), "reason": "1 broken", "kind": "DAMAGE",
                                                "lines": [{"product": product.pk, "quantity": "61"}]}, format="json")  # breakage
    day2 = row(office, product, date=str(D2))
    assert day2["opening_stock"] == "75"  # yesterday's closing (AT-STK-02)
    assert (day2["incoming"], day2["total_item_stock"], day2["sales"], day2["other_out"], day2["closing_stock"]) == ("2", "77", "15", "1", "61")
    assert day2["stock"] == "61" and stock_of(product) == 61  # current stock is the ledger balance
    assert row(office, product, date=str(D1))["closing_stock"] == "75"  # the earlier day is unchanged by later movements
    both = row(office, product, date_from=str(D1), date_to=str(D2))
    assert (both["opening_stock"], both["incoming"], both["sales"], both["closing_stock"]) == ("100", "22", "60", "61")


# --- Weighted-average cost; 6, 7, 8. Total Sales and gross profit, with refunds and cancellations --

def test_profit_uses_the_purchase_price_of_the_day_as_the_workbook_does_not_the_weighted_average(accountant, cashier, shop, make_product):
    """Owner's decision, 13 Oct 2026: Profit = Sales x (Sales price - Purchase price that day). No weighted average."""
    product = make_product("Konyagi", "4500", 10, cost_price=Decimal("3000"))  # 10 in stock, purchase price 3,000
    office = client_for(accountant)
    receive(office, product, 30, "4000")  # a delivery at 4,000 that does not change the product's purchase price
    product.refresh_from_db()
    assert product.average_cost == Decimal("3750")  # still worked out, for information only
    assert product.cost_price == 3000  # the purchase price is untouched unless asked
    line = GoodsReceiptLine.objects.get()
    assert (line.unit_cost, line.average_cost_before, line.average_cost_after) == (4000, 3000, 3750)  # purchase history kept

    till = client_for(cashier)
    start_shift(till)
    sell(till, [(product, 8)], [(shop.cash, 36000)])
    first = SaleItem.objects.get()
    assert (first.unit_cost, first.cost_total) == (3000, 24000)  # the purchase price of the day, not the 3,750 average

    receive(office, product, 32, "5000", update_cost_price=True)  # the purchase price becomes 5,000 from now on
    product.refresh_from_db()
    assert product.cost_price == 5000
    first.refresh_from_db()
    assert first.cost_total == 24000  # the purchase price stored with a sale already made is never rewritten
    shown = row(office, product)
    assert (shown["purchase_price"], shown["total_sales"], shown["cost_of_goods_sold"], shown["profit"], shown["profit_status"]) == (
        "5000", "36000", "24000", "12000", "OK")  # 8 x (4,500 - 3,000)
    sell(till, [(product, 2)], [(shop.cash, 9000)])
    assert row(office, product)["profit"] == "11000"  # plus 2 x (4,500 - 5,000): the new purchase price applies to new sales only
    stock = office.get("/api/v1/reports/stock-on-hand/").data
    assert stock["rows"][0]["stock_value"] == "310000"  # 62 x the purchase price of 5,000


def test_total_sales_and_gross_profit_with_refunds_and_cancellations(cashier, accountant, shop, make_product):
    a = make_product("Konyagi", "4500", 100, cost_price=Decimal("3000"))
    b = make_product("Safari", "2500", 100, cost_price=Decimal("2000"))
    till, office = client_for(cashier), client_for(accountant)
    start_shift(till)
    sale = sell(till, [(a, 10), (b, 4)], [(shop.cash, 55000)]).data
    cancelled = sell(till, [(a, 5)], [(shop.cash, 22500)]).data
    office.post(f"/api/v1/sales/{cancelled['id']}/void/", {"reason": "wrong customer"}, format="json")
    refund(office, sale, 2, shop.cash)                     # 2 Konyagi back on the shelf: revenue and cost both come back
    data = table(office, page_size=500)
    rows = {r["name"]: r for r in data["results"]}
    assert (rows["Konyagi"]["total_sales"], rows["Konyagi"]["cost_of_goods_sold"], rows["Konyagi"]["profit"]) == ("36000", "24000", "12000")
    assert (rows["Safari"]["total_sales"], rows["Safari"]["profit"]) == ("10000", "2000")
    assert data["totals"] == {"total_sales": "46000", "profit": "14000", "profit_unavailable_for": 0, "profit_provisional_for": 0}

    # Total Sales reconciles to the day's net sales, and is not stock x price
    from trading.services import day_figures, open_day
    assert day_figures(open_day())["net_sales"] == 46000
    assert rows["Konyagi"]["stock"] == "92" and Decimal(rows["Konyagi"]["total_sales"]) != 92 * 4500

    # a damaged return gives the money back but the goods stay a cost
    other = sell(till, [(b, 1)], [(shop.cash, 2500)]).data
    refund(office, other, 1, shop.cash, restock=False)
    safari = row(office, b)
    assert (safari["total_sales"], safari["cost_of_goods_sold"], safari["profit"]) == ("10000", "10000", "0")
    assert stock_of(b) == 95

    # general expenses are not part of product gross profit
    office.post("/api/v1/expenses/", {"request_key": str(uuid.uuid4()), "category": "Rent", "description": "October rent",
                                      "amount": "500000", "method": shop.bank.pk}, format="json")
    assert table(office, page_size=500)["totals"]["profit"] == "12000"
    by_product = office.get("/api/v1/reports/sales-by-product/").data
    assert by_product["totals"]["gross_profit"] == "12000" and by_product["totals"]["cost_of_goods"] == "34000"


def test_profit_is_unavailable_or_provisional_rather_than_invented(cashier, accountant, shop, make_product):
    unknown = make_product("No cost known", "5000", 10, cost_price=None, average_cost=None)
    assumed = make_product("Cost assumed", "5000", 10, cost_price=Decimal("3000"))
    till, office = client_for(cashier), client_for(accountant)
    receive(office, assumed, 10)  # a delivery recorded with no cost: carried at the existing average, marked provisional
    assumed.refresh_from_db()
    assert assumed.average_cost == 3000 and assumed.cost_provisional is True
    start_shift(till)
    sell(till, [(unknown, 2), (assumed, 2)], [(shop.cash, 20000)])
    rows = {r["name"]: r for r in table(office, page_size=500)["results"]}
    assert (rows["No cost known"]["purchase_price"], rows["No cost known"]["profit"], rows["No cost known"]["profit_status"]) == (None, None, "UNAVAILABLE")
    assert rows["No cost known"]["total_sales"] == "10000"  # sales are still reported
    assert (rows["Cost assumed"]["profit"], rows["Cost assumed"]["profit_status"], rows["Cost assumed"]["purchase_price_provisional"]) == ("4000", "OK", False)  # 2 x (5,000 - 3,000)
    totals = table(office, page_size=500)["totals"]
    assert (totals["profit"], totals["profit_unavailable_for"], totals["profit_provisional_for"]) == ("4000", 1, 0)
    csv_text = office.get("/api/v1/products/table/?download=csv").content.decode("utf-8-sig")
    assert "Profit not available" in csv_text


def test_opening_stock_is_valued_at_the_entered_purchase_price(owner, shop):
    shop.cfg.went_live_at = None
    shop.cfg.save()
    boss = client_for(owner)
    made = boss.post("/api/v1/products/", {"name": "Konyagi", "selling_price": "4500", "cost_price": "3750"}, format="json").data
    assert made["average_cost"] is None  # no stock yet, so nothing to value
    sheet = boss.post("/api/v1/stock/opening-counts/", {"request_key": str(uuid.uuid4()), "count_date": "2026-10-31", "counted_by_name": "Asha",
                      "lines": [{"product": made["id"], "quantity": "48"}]}, format="json").data
    boss.post(f"/api/v1/stock/opening-counts/{sheet['id']}/review/", {"approve": True}, format="json")
    product = Product.objects.get(pk=made["id"])
    assert product.average_cost == Decimal("3750") and product.cost_provisional is False


# --- 9. A cashier never receives purchase prices or profit ----------------------------------------

def test_cashier_cannot_reach_cost_or_profit(cashier, accountant, shop, make_product):
    product = make_product(stock=10)
    till = client_for(cashier)
    for url in ("/api/v1/products/table/", "/api/v1/products/table/?download=csv", f"/api/v1/products/{product.pk}/details/",
                "/api/v1/reports/sales-by-product/", "/api/v1/reports/stock-on-hand/"):
        assert till.get(url).status_code == 403, url
    assert till.post(f"/api/v1/products/{product.pk}/units/", {"name": "Crate", "factor": "12", "selling_price": "1"}, format="json").status_code == 403
    start_shift(till)
    sale = sell(till, [(product, 1)], [(shop.cash, 4500)]).data
    listed = till.get("/api/v1/products/").data["results"][0]
    single = till.get(f"/api/v1/products/{product.pk}/").data
    receipt = till.get(f"/api/v1/sales/{sale['id']}/").data
    for payload in (listed, single, receipt, receipt["items"][0], sale["items"][0]):
        assert not {"cost_price", "average_cost", "cost_provisional", "unit_cost", "cost_total", "profit", "purchase_price"} & set(payload), payload
    assert {"volume_ml", "base_unit", "selling_price"} <= set(listed)  # what a cashier does need
    assert client_for(accountant).get("/api/v1/products/table/").status_code == 200


# --- 10. A price change never alters past receipts or past sales figures --------------------------

def test_changing_the_selling_price_leaves_history_alone(owner, cashier, shop, make_product):
    product = make_product("Konyagi", "4500", 20, cost_price=Decimal("3000"))
    till, boss = client_for(cashier), client_for(owner)
    start_shift(till)
    sale = sell(till, [(product, 2)], [(shop.cash, 9000)]).data
    before = row(boss, product)
    assert boss.patch(f"/api/v1/products/{product.pk}/", {"selling_price": "6000", "cost_price": "9999", "name": "Konyagi Gold"}, format="json").status_code == 200
    receipt = till.get(f"/api/v1/sales/{sale['id']}/").data
    assert (receipt["total"], receipt["items"][0]["unit_price"], receipt["items"][0]["product_name"]) == ("9000.00", "4500.00", "Konyagi")
    after = row(boss, product)
    assert after["selling_price"] == "6000" and after["name"] == "Konyagi Gold"
    for figure in ("total_sales", "cost_of_goods_sold", "profit", "sales"):
        assert after[figure] == before[figure], figure  # 9,000 sales, 6,000 cost, 3,000 profit: kept as sold
    assert after["purchase_price"] == "9999"  # the new purchase price shows, and applies to new sales only
    assert sell(till, [(product, 1)], [(shop.cash, 6000)]).data["total"] == "6000.00"  # new sales use the new price
    assert row(boss, product)["total_sales"] == "15000"


# --- 11. Search, sorting, filtering and pagination on a large list --------------------------------

def test_table_search_sort_and_pagination(owner, make_product):
    for i in range(1, 61):
        make_product(f"Product {i:03d}", str(1000 + i), base_unit="Crate" if i % 2 else "Bottle", volume_ml=330 if i % 3 == 0 else None,
                     is_active=i != 60)
    client = client_for(owner)
    first = table(client)
    assert (first["count"], first["page"], first["page_size"], first["pages"], len(first["results"])) == (60, 1, 25, 3, 25)
    assert [r["name"] for r in first["results"][:2]] == ["Product 001", "Product 002"]
    last = table(client, page=3)
    assert len(last["results"]) == 10 and last["results"][-1]["name"] == "Product 060"
    assert table(client, page=9)["results"] == []
    assert client.get("/api/v1/products/table/?page=x").status_code == 400

    by_price = table(client, ordering="-selling_price", page_size=3)["results"]
    assert [r["selling_price"] for r in by_price] == ["1060", "1059", "1058"]
    by_volume = table(client, ordering="volume_ml", page_size=500)["results"]
    assert by_volume[0]["volume_ml"] == 330 and by_volume[-1]["volume_ml"] is None  # blanks go last, not first
    assert table(client, ordering="not_a_column", page_size=1)["results"][0]["name"] == "Product 001"

    assert table(client, search="product 04")["count"] == 11  # 004 and 040-049: every word must match
    assert table(client, search="zzz")["count"] == 0 and table(client, search="zzz")["results"] == []
    assert table(client, sold_by="Crate")["count"] == 30 and table(client, active="false")["count"] == 1
    assert table(client, active="true", sold_by="Bottle")["count"] == 29
    assert client.get("/api/v1/products/table/?date_from=2026-11-05&date_to=2026-11-01").status_code == 400
    assert client.get("/api/v1/products/table/?date=not-a-date").status_code == 400


def test_product_details_show_package_movements_and_cost_history(owner, accountant, cashier, shop, make_product):
    product = make_product("Konyagi", "4500", 10, cost_price=Decimal("3000"), base_unit="Bottle", volume_ml=200)
    office = client_for(accountant)
    receive(office, product, 30, "4000", reference="INV-9")
    client_for(owner).patch(f"/api/v1/products/{product.pk}/", {"selling_price": "5000"}, format="json")
    till = client_for(cashier)
    start_shift(till)
    sell(till, [(product, 3)], [(shop.cash, 15000)])
    details = office.get(f"/api/v1/products/{product.pk}/details/").data
    assert details["product"]["volume_ml"] == 200 and details["product"]["average_cost"] == "3750.0000"
    assert (details["figures"]["total_item_stock"], details["figures"]["sales"], details["figures"]["closing_stock"]) == ("40", "3", "37")
    assert [(m["type"], m["change"], m["balance_after"]) for m in details["movements"]] == [
        ("Sale", "-3", "37"), ("Stock received", "30", "40"), ("Opening stock", "10", "10")]
    assert details["purchases"] == [{"date": details["purchases"][0]["date"], "supplier": "", "reference": "INV-9", "quantity": "30",
                                     "unit_cost": "4000", "average_before": "3000", "average_after": "3750"}]
    assert details["changes"][0]["after"] == {"selling_price": "5000.00"} and details["changes"][0]["by"] == "owner"


def test_table_export_matches_the_screen(owner, cashier, shop, make_product):
    product = make_product("Konyagi", "4500", 20, cost_price=Decimal("3000"), base_unit="Crate", volume_ml=500)
    till = client_for(cashier)
    start_shift(till)
    sell(till, [(product, 2)], [(shop.cash, 9000)])
    response = client_for(owner).get("/api/v1/products/table/?download=csv")
    assert response.status_code == 200 and response["Content-Type"].startswith("text/csv") and "attachment" in response["Content-Disposition"]
    lines = response.content.decode("utf-8-sig").splitlines()
    assert lines[1] == "S/No,Product,Unit,Volume (ml),Total Stock,Sales,Closing Stock,Purchase Price,Selling Price,Total Sales,Profit,Stock on Hand,Notes"
    assert lines[2] == "1,Konyagi,Crate,500,20,2,18,3000,4500,9000,3000,18,"
    assert lines[3].startswith(",TOTAL,,,,,,,,9000,3000")
    assert AuditLog.objects.filter(action="report.exported").count() == 1
