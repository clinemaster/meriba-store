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
HEADINGS = ["S/N", "Details", "Opening stock", "Add Purchases", "Sales", "Closing stock", "Purchase price",
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
    assert client_for(cashier).get("/api/v1/daily-sheet/", {"date": str(SEP10)}).status_code == 403  # the cashier sees today only
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

    till.post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "157500", "payments_reviewed": True}, format="json")
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
    assert rows[2] == "1,Konyagi ndogo,434,0,35,399,3750,4500,157500,26250,1795500,0"  # identical to the workbook's 1 October line
    assert rows[3] == ",TOTAL,,0,35,,,,157500,26250,1795500,0"


def test_the_cashier_types_sales_on_todays_sheet_without_seeing_costs(owner, cashier, shop, make_product, set_today):
    product = make_product("Konyagi ndogo", "4500", 434, cost_price=Decimal("3750"))
    till = client_for(cashier)
    set_today(D1)
    start_shift(till)
    # typing 35 against the product on the sheet records an ordinary sale, with how it was paid
    sell(till, [(product, 35)], [(shop.momo, 157500)])
    data = get(till)
    assert [c["label"] for c in data["columns"]] == ["S/N", "Details", "Opening stock",     "Add Purchases", "Sales",
                                                     "Closing stock", "Sales price", "Total Sales", "Stock"]
    row = data["lines"][0]
    assert (row["opening"], row["sales"], row["closing_stock"], row["sales_price"], row["total_sales"], row["stock"]) == (
        "434", "35", "399", "4500", "157500", "1795500")
    assert not {"purchase_price", "profit", "total_purchases"} & (set(row) | set(data["totals"]))
    assert (data["previous_date"], data["next_date"]) == (None, None)
    assert till.get("/api/v1/daily-sheet/", {"date": "2026-11-01"}).status_code == 403
    exported = till.get("/api/v1/daily-sheet/?download=csv")
    assert exported.status_code == 200 and exported["Content-Type"].startswith("text/csv")
    export_rows = exported.content.decode("utf-8-sig").splitlines()
    cashier_headings = [heading for heading in HEADINGS if heading not in {"Purchase price", "Profit", "T.Purchases"}]
    assert export_rows[1] == ",".join(cashier_headings)
    assert len(export_rows[2].split(",")) == len(cashier_headings)
    assert till.get("/api/v1/daily-sheet/?date=2026-11-01&download=csv").status_code == 403
    assert get(client_for(owner))["lines"][0]["profit"] == "26250"  # the office still sees the whole sheet

def test_empty_profit_cells_stay_empty_and_are_flagged_for_the_owner(owner, accountant):
    """Owner's decision, 13 Oct 2026: do not fill them. A later correction is the Owner's, kept beside the record."""
    from core.models import AuditLog

    blank_profit = line(7, "Hajos wine dum", 12, 2, 25000, 30000)
    blank_profit[10] = None
    no_sales = line(8, "Henken", 5, 0, 3125, 4000)
    no_sales[10] = None  # empty, but nothing was sold: not a missing figure
    commit(client_for(owner), workbook({AUG31: [line(1, "Konyagi ndogo", 100, 10, 3750, 4500), blank_profit, no_sales]}, with_totals=False))
    boss, office = client_for(owner), client_for(accountant)

    flagged = office.get("/api/v1/history/empty-profit-cells/").data
    assert (flagged["count"], flagged["awaiting_review"]) == (1, 1)
    cell = flagged["cells"][0]
    assert (cell["worksheet"], cell["row"], cell["product"], cell["sales"], cell["written"], cell["formula_would_give"], cell["correction"]) == (
        "31.08.2026", 5, "Hajos wine dum", "2", None, "10000.00", None)

    url = f"/api/v1/history/empty-profit-cells/{cell['id']}/correct/"
    assert office.post(url, {"approved_value": "10000", "reason": "Formula was not copied down"}, format="json").status_code == 403  # Owner only
    assert boss.post(url, {"approved_value": "10000", "reason": ""}, format="json").status_code == 400  # a reason is required
    assert HistoricalRecord.objects.get(pk=cell["id"]).profit is None and get(boss, date=str(AUG31))["lines"][1]["approved_profit"] is None

    done = boss.post(url, {"approved_value": "10000", "reason": "Formula was not copied down"}, format="json")
    assert done.status_code == 201 and done.data["correction"]["approved_value"] == "10000.00"
    assert HistoricalRecord.objects.get(pk=cell["id"]).profit is None  # the original record still shows the empty cell
    shown = get(boss, date=str(AUG31))["lines"][1]
    assert (shown["profit"], shown["approved_profit"], shown["formula_differs"]) == (None, "10000", ["profit"])
    assert get(boss, date=str(AUG31))["totals"]["profit"] == "7500"  # the workbook's own total is unchanged
    log = AuditLog.objects.get(action="history.profit_correction_approved")
    assert log.actor == owner and log.reason == "Formula was not copied down" and "31.08.2026 row 5" in log.summary
    assert boss.post(url, {"approved_value": "9000", "reason": "Second thoughts"}, format="json").status_code == 409  # never replaced
    assert office.get("/api/v1/history/empty-profit-cells/").data["awaiting_review"] == 0


def test_stock_total_falls_by_each_days_sales_and_carries_forward(owner, accountant, cashier, shop, make_product, set_today):
    """The money value in the Stock column (Closing stock x Sales price, summed) goes down by Total Sales as sales are
    recorded, a cancelled sale is given back once, and the closing value is the next day's starting value. Quantities
    are worked out on their own; no money amount is ever taken off a quantity."""
    a = make_product("Konyagi ndogo", "4500", 10000)  # 45,000,000 at selling price
    b = make_product("Safari lager", "2500", 11091)   # 27,727,500 at selling price
    till, office = client_for(cashier), client_for(accountant)
    set_today(D1)
    shift = start_shift(till)
    assert get(office)["totals"]["stock"] == "72727500"

    sell(till, [(a, 10)], [(shop.cash, 45000)])  # the example: a day's sales of TZS 45,000
    day = get(office)
    assert (day["totals"]["total_sales"], day["totals"]["stock"]) == ("45000", "72682500")  # 72,727,500 - 45,000
    assert day["lines"][0]["closing_stock"] == "9990"  # a quantity, in bottles

    wrong = sell(till, [(b, 2)], [(shop.cash, 5000)]).data
    assert get(office)["totals"]["stock"] == "72677500"
    office.post(f"/api/v1/sales/{wrong['id']}/void/", {"reason": "entered by mistake"}, format="json")
    assert get(office)["totals"]["stock"] == "72682500"  # given back once, and only once
    assert get(office)["totals"]["stock"] == "72682500"  # looking again changes nothing

    till.post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "45000", "payments_reviewed": True}, format="json")
    set_today(D2)
    start_shift(till)
    assert get(office)["totals"]["stock"] == "72682500"  # yesterday's closing value is today's starting value
    sell(till, [(b, 4)], [(shop.cash, 10000)])
    assert get(office)["totals"]["stock"] == "72672500"
    assert get(office, date=str(D1))["totals"]["stock"] == "72682500"  # the closed day is not touched


def test_owner_sees_the_stock_value_after_each_days_sales(owner, accountant, cashier, shop, make_product, set_today):
    """Yesterday's Stock total, less today's sales (with deliveries, returns and price changes shown on their own lines),
    gives today's Stock total."""
    a = make_product("Konyagi ndogo", "4500", 10000)
    b = make_product("Castle laga ndogo", "37500", 20)  # 750,000
    till, office, boss = client_for(cashier), client_for(accountant), client_for(owner)
    set_today(D1)
    shift = start_shift(till)
    sell(till, [(a, 10)], [(shop.cash, 45000)])
    first = office.get("/api/v1/daily-sheet/stock-value/").data["stock_value"]
    assert (first["previous_value"], first["opening_value"], first["deliveries"], first["sales"], first["other"], first["closing_value"]) == (
        None, "45750000", "0", "45000", "0", "45705000")  # 45,750,000 - 45,000
    till.post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "45000", "payments_reviewed": True}, format="json")

    # Next day: 5 crates delivered and the same 5 sold (as on 16 Oct), and Konyagi goes up by 500.
    boss.patch(f"/api/v1/products/{a.pk}/", {"selling_price": "5000"}, format="json")
    set_today(D2)
    start_shift(till)
    office.post("/api/v1/stock/receipts/", {"request_key": str(uuid.uuid4()),
                                            "lines": [{"product": b.pk, "quantity": "5", "unit_cost": "30000"}]}, format="json")
    sell(till, [(b, 5)], [(shop.cash, 187500)])
    day = get(office)
    value = day["stock_value"]
    assert (str(value["previous_date"]), value["previous_value"]) == (str(D1), "45705000")
    assert value["price_changes"] == "4995000"  # 9,990 bottles x 500
    assert (value["opening_value"], value["deliveries"], value["sales"], value["closing_value"]) == (
        "50700000", "187500", "187500", "50700000")
    assert value["closing_value"] == day["totals"]["stock"]  # always the sheet's own Stock total
    assert get(client_for(cashier)).get("stock_value") is None  # the money statement is for the office
    assert client_for(cashier).get("/api/v1/daily-sheet/stock-value/").status_code == 403


def test_home_page_stock_value_falls_back_to_the_latest_day(owner, cashier, shop, make_product, set_today):
    product = make_product("Konyagi ndogo", "4500", 100)
    till = client_for(cashier)
    set_today(D1)
    shift = start_shift(till)
    sell(till, [(product, 2)], [(shop.cash, 9000)])
    till.post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "9000", "payments_reviewed": True}, format="json")
    set_today(D2)  # no day started yet
    value = client_for(owner).get("/api/v1/daily-sheet/stock-value/").data["stock_value"]
    assert (str(value["date"]), value["source"], value["sales"], value["closing_value"]) == (str(D1), "CLOSED", "9000", "441000")
