"""The Daily Sheet reproduces the Excel workbook's layout and formulas (requirement of 13 Oct 2026).

Figures used below for 1 and 3 October are the real ones from the workbook's Konyagi ndogo line."""
import uuid
from datetime import date
from decimal import Decimal

from history.models import HistoricalRecord
from trading import sheet
from trading.models import DailySheetLine

from .conftest import client_for, sell, start_shift
from .test_history import AUG31, SEP10, commit, line, primary, workbook

D1, D2 = date(2026, 11, 2), date(2026, 11, 3)
HEADINGS = ["S/N", "Details", "Opening stock", "Add Purchases", "Total stock", "Sales", "Closing stock", "Purchase price",
            "Sales price", "Total Sales", "Profit", "Stock", "T.Purchases"]


def get(client, **params):
    response = client.get("/api/v1/daily-sheet/", params)
    assert response.status_code == 200, response.data
    return response.data


def test_the_workbooks_formulas_on_two_real_lines():
    # 01.10.2026 row 4: opening 434, no purchases, 35 sold, purchase price 3,750, sales price 4,500
    one = sheet.excel_line(434, None, 35, Decimal("3750"), Decimal("4500"))
    assert (one["total_stock"], one["closing_stock"], one["total_sales"], one["profit"], one["stock"], one["total_purchases"]) == (
        434, 399, 157500, 26250, 1795500, 0)
    # 03.10.2026 row 4: opening 379, 360 bought, 35 sold
    three = sheet.excel_line(379, 360, 35, Decimal("3750"), Decimal("4500"))
    assert (three["total_stock"], three["closing_stock"], three["total_sales"], three["profit"], three["stock"], three["total_purchases"]) == (
        739, 704, 157500, 26250, 3168000, 1350000)
    # with no purchase price the workbook would count the blank as zero; the system leaves profit empty instead
    assert sheet.excel_line(10, 0, 2, None, 4500)["profit"] is None


def test_formulas_reproduce_every_imported_line_and_report_what_the_workbook_left_blank(owner):
    blank_profit = line(7, "Hajos wine dum", 12, 2, 25000, 30000)
    blank_profit[10] = None  # the Profit cell is empty in the workbook for this product
    days = {AUG31: [line(1, "Konyagi ndogo", 100, 10, 3750, 4500), blank_profit],
            SEP10: [line(1, "Konyagi ndogo", 70, 5, 3750, 4500), line(7, "Hajos wine dum", 10, 0, 25000, 30000)]}
    assert commit(client_for(owner), workbook(days, with_totals=False)).status_code == 201
    result = sheet.compare_with_workbook()
    assert (result["lines_checked"], result["figures_checked"], result["mismatches"]) == (4, 24, [])
    assert result["blank_cells"] == [{"where": "31.08.2026 row 5 Hajos wine dum", "column": "profit", "formula_gives": "10000"}]
    assert [(b["previous_closing"], b["opening"]) for b in result["opening_not_previous_closing"]] == [("90.000", "70.000")]
    # the stored record is untouched: the blank stays blank
    assert HistoricalRecord.objects.get(business_date=AUG31, source_row=5).profit is None
    api = client_for(owner).get("/api/v1/daily-sheet/compare-with-workbook/").data
    assert api["counts"] == {"mismatches": 0, "blank_cells": 1, "opening_not_previous_closing": 1}


def test_an_excel_day_is_shown_exactly_as_written(owner, cashier):
    commit(client_for(owner), primary())
    data = get(client_for(owner), date=str(SEP10))
    assert data["source"] == "EXCEL" and "exactly as written" in data["note"]
    assert [c["label"] for c in data["columns"]] == HEADINGS  # the workbook's headings, in the workbook's order
    konyagi = data["lines"][0]
    assert (konyagi["number"], konyagi["details"], konyagi["opening"], konyagi["purchases"], konyagi["total_stock"], konyagi["sales"],
            konyagi["closing_stock"], konyagi["purchase_price"], konyagi["sales_price"], konyagi["total_sales"], konyagi["profit"],
            konyagi["stock"], konyagi["total_purchases"]) == (1, "Konyagi ndogo", "70", None, "70", "5", "65", "3750", "4500", "22500", "3750", "292500", "0")
    assert konyagi["source"] == "10.09.2026 row 4" and konyagi["incomplete"] is True  # opening 70 after closing 90: flagged, not altered
    assert (data["previous_date"], data["next_date"]) == (AUG31, date(2026, 9, 11))
    assert data["totals"]["total_sales"] == "22500"
    missing = get(client_for(owner), date="2026-09-05")
    assert missing["source"] == "NONE" and missing["lines"] == [] and missing["previous_date"] == AUG31  # nothing invented for missing days
    assert client_for(cashier).get("/api/v1/daily-sheet/").status_code == 403  # shows purchase prices and profit
    assert client_for(cashier).get("/api/v1/daily-sheet/compare-with-workbook/").status_code == 403


def test_a_live_day_follows_the_same_formulas_and_carries_forward(owner, accountant, cashier, shop, make_product, set_today):
    product = make_product("Konyagi ndogo", "4500", 434, cost_price=Decimal("3750"))
    till, office, boss = client_for(cashier), client_for(accountant), client_for(owner)
    set_today(D1)
    shift = start_shift(till)
    office.post("/api/v1/stock/receipts/", {"request_key": str(uuid.uuid4()),
                                            "lines": [{"product": product.pk, "quantity": "360", "unit_cost": "3750"}]}, format="json")
    sell(till, [(product, 35)], [(shop.cash, 157500)])

    live = get(office)
    row = live["lines"][0]
    assert live["source"] == "LIVE" and live["date"] == D1
    assert (row["number"], row["details"], row["opening"], row["purchases"], row["total_stock"], row["sales"], row["closing_stock"]) == (
        1, "Konyagi ndogo", "434", "360", "794", "35", "759")
    assert (row["purchase_price"], row["sales_price"], row["total_sales"], row["profit"], row["stock"], row["total_purchases"]) == (
        "3750", "4500", "157500", "26250", "3415500", "1350000")
    assert row["differs_from_recorded"] is False and row["other_movements"] == "0"
    assert live["totals"] == {"purchases": "360", "sales": "35", "total_sales": "157500", "profit": "26250", "stock": "3415500", "total_purchases": "1350000"}
    assert not DailySheetLine.objects.exists()

    till.post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "157500"}, format="json")
    kept = DailySheetLine.objects.get()
    assert (kept.opening, kept.purchases, kept.sales, kept.closing_stock, kept.total_sales, kept.profit, kept.stock) == (434, 360, 35, 759, 157500, 26250, 3415500)

    # the next day: prices change, but yesterday's sheet stays as it was, and today opens with yesterday's closing
    boss.patch(f"/api/v1/products/{product.pk}/", {"selling_price": "5000", "cost_price": "4000"}, format="json")
    set_today(D2)
    start_shift(till)
    sell(till, [(product, 10)], [(shop.cash, 50000)])
    yesterday = get(office, date=str(D1))
    assert yesterday["source"] == "CLOSED"
    assert (yesterday["lines"][0]["sales_price"], yesterday["lines"][0]["total_sales"], yesterday["lines"][0]["profit"]) == ("4500", "157500", "26250")
    today = get(office)["lines"][0]
    assert (today["opening"], today["sales"], today["closing_stock"], today["sales_price"], today["total_sales"], today["profit"]) == (
        "759", "10", "749", "5000", "50000", "10000")  # opening = previous closing; profit = 10 x (5,000 - 4,000)


def test_what_the_workbook_cannot_express_is_shown_not_hidden(accountant, cashier, shop, make_product):
    product = make_product("Konyagi ndogo", "4500", 20, cost_price=Decimal("3750"))
    till, office = client_for(cashier), client_for(accountant)
    start_shift(till)
    sale = sell(till, [(product, 4)], [(shop.cash, 18000)]).data
    office.post(f"/api/v1/sales/{sale['id']}/refund/", {"request_key": str(uuid.uuid4()), "reason": "Customer return", "method": shop.cash.pk,
                "lines": [{"sale_item": sale["items"][0]["id"], "quantity": "1", "restock": True}]}, format="json")
    data = get(office)
    row = data["lines"][0]
    # the workbook has no column for a return: Sales stays 4, the returned bottle is shown as another movement
    assert (row["sales"], row["other_movements"], row["closing_stock"], row["total_sales"]) == ("4", "1", "17", "18000")
    assert (row["recorded_sales_value"], row["differs_from_recorded"]) == ("13500", True)  # 18,000 sold less 4,500 refunded
    assert (data["lines_with_other_movements"], data["lines_differing_from_recorded"]) == (1, 1)


def test_daily_sheet_export_uses_the_workbooks_headings(owner, cashier, shop, make_product):
    product = make_product("Konyagi ndogo", "4500", 434, cost_price=Decimal("3750"))
    till = client_for(cashier)
    start_shift(till)
    sell(till, [(product, 35)], [(shop.cash, 157500)])
    response = client_for(owner).get("/api/v1/daily-sheet/?download=csv")
    assert response.status_code == 200 and response["Content-Type"].startswith("text/csv")
    rows = response.content.decode("utf-8-sig").splitlines()
    assert rows[1] == ",".join(HEADINGS)
    assert rows[2] == "1,Konyagi ndogo,434,0,434,35,399,3750,4500,157500,26250,1795500,0"  # identical to the workbook's 1 October line
    assert rows[3] == ",TOTAL,,0,,35,,,,157500,26250,1795500,0"
