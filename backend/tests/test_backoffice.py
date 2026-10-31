"""Refunds, closed-day corrections, receiving stock, expenses and reports
(AT-10, AT-STK-01..04, AT-SALES-05, and the owner's decisions of 12 Oct 2026)."""
import uuid
from datetime import date
from decimal import Decimal

import pytest

from core.models import AuditLog
from inventory.models import InventoryMovement
from sales.models import Refund, Sale
from trading.models import BusinessDay, DayCorrection

from .conftest import client_for, sell, start_shift, stock_of

D1, D2, D3 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4)


def close(client, shift_id, counted, note=""):
    return client.post(f"/api/v1/shifts/{shift_id}/close/", {"counted_cash": str(counted), "note": note, "payments_reviewed": True}, format="json")


def refund(client, sale, lines, method, **extra):
    body = {"request_key": str(uuid.uuid4()), "reason": "Customer brought it back", "method": method.pk,
            # A category that needs a provider (Mobile Money, Bank) refunds through its first one unless told otherwise.
            "provider": getattr(method.providers.order_by("sort_order").first(), "pk", None) if method.requires_provider else None,
            "lines": [{"sale_item": sale["items"][i]["id"], "quantity": str(q), "restock": restock} for i, q, restock in lines]}
    return client.post(f"/api/v1/sales/{sale['id']}/refund/", body | extra, format="json")


def receive(client, lines, **extra):
    body = {"request_key": str(uuid.uuid4()), "lines": [{"product": p.pk, "quantity": str(q), "unit_cost": c} for p, q, c in lines]}
    return client.post("/api/v1/stock/receipts/", body | extra, format="json")


# --- Refunds --------------------------------------------------------------------

def test_at10_return_of_two_resalable_units(cashier, accountant, shop, make_product):
    product = make_product(price="1000", stock=10)
    till = client_for(cashier)
    start_shift(till)
    sale = sell(till, [(product, 5)], [(shop.cash, 5000)]).data
    response = refund(client_for(accountant), sale, [(0, 2, True)], shop.cash)
    assert response.status_code == 201, response.data
    assert response.data["refunded_total"] == "2000.00" and response.data["items"][0]["refunded_quantity"] == "2.000"
    assert response.data["status"] == "COMPLETED"  # the sale itself is untouched
    assert stock_of(product) == 7
    movement = InventoryMovement.objects.get(movement_type="RETURN")
    assert (movement.quantity_delta, movement.source_type) == (2, "Refund")
    assert Refund.objects.get().sale_id == sale["id"]  # linked to the original sale
    assert AuditLog.objects.filter(action="sale.refunded").count() == 1


def test_refund_after_day_closure_goes_on_the_current_day_and_never_changes_the_closed_day(
        cashier, accountant, shop, make_product, set_today):
    product = make_product(price="1000", stock=100)
    till, office = client_for(cashier), client_for(accountant)
    set_today(D1)
    shift = start_shift(till)
    sale = sell(till, [(product, 30)], [(shop.cash, 30000)]).data
    close(till, shift["id"], 30000)
    day1_before = BusinessDay.objects.filter(date=D1).values().get()

    no_day = refund(office, sale, [(0, 5, True)], shop.cash)
    assert no_day.status_code == 409 and no_day.data["code"] == "no_open_day"

    set_today(D2)
    shift2 = start_shift(till, "20000")
    sell(till, [(product, 10)], [(shop.cash, 10000)])
    assert refund(office, sale, [(0, 5, True)], shop.cash).status_code == 201

    figures = till.get("/api/v1/day/current/").data["shift_figures"]
    assert figures["cash_refunds"] == "5000.00"
    assert figures["expected_cash"] == "25000.00"  # 20,000 float + 10,000 cash sales − 5,000 cash refund (FR-REC-04)
    day2 = close(till, shift2["id"], 25000).data["day"]
    assert (day2["gross_sales"], day2["refunds"], day2["net_sales"]) == ("10000.00", "5000.00", "5000.00")
    assert (day2["opening_cumulative_sales"], day2["closing_cumulative_sales"]) == ("30000.00", "35000.00")
    assert BusinessDay.objects.filter(date=D1).values().get() == day1_before  # closed day untouched
    assert Refund.objects.get().business_day.date == D2
    assert stock_of(product) == 65


def test_refund_rules(cashier, accountant, shop, make_product):
    product = make_product(price="1000", stock=10)
    till, office = client_for(cashier), client_for(accountant)
    start_shift(till)
    sale = sell(till, [(product, 4)], [(shop.momo, 4000)]).data

    assert refund(till, sale, [(0, 1, True)], shop.cash).status_code == 403  # cashiers cannot refund
    assert refund(office, sale, [(0, 1, True)], shop.cash, reason="  ").status_code == 400
    too_many = refund(office, sale, [(0, 5, True)], shop.cash)
    assert too_many.status_code == 400 and too_many.data["code"] == "over_refund"

    damaged = refund(office, sale, [(0, 1, False)], shop.momo)  # broken bottle: money back, not back on the shelf
    assert damaged.status_code == 201 and stock_of(product) == 6
    assert till.get("/api/v1/day/current/").data["shift_figures"]["cash_refunds"] == "0.00"  # non-cash refund leaves the drawer alone

    key = str(uuid.uuid4())
    first = refund(office, sale, [(0, 3, True)], shop.cash, request_key=key)
    again = refund(office, sale, [(0, 3, True)], shop.cash, request_key=key)
    assert (first.status_code, again.status_code) == (201, 200)
    assert Refund.objects.count() == 2 and stock_of(product) == 9  # FR-RET-04: not processed twice
    assert refund(office, sale, [(0, 1, True)], shop.cash).data["code"] == "over_refund"  # nothing left to refund

    void = office.post(f"/api/v1/sales/{sale['id']}/void/", {"reason": "try to cancel as well"}, format="json")
    assert void.status_code == 409 and void.data["code"] == "has_refund"
    assert Sale.objects.get().status == "COMPLETED"


def test_voided_sale_is_deducted_exactly_once(cashier, accountant, shop, make_product):
    """A cancelled sale is in gross once and taken off once; it is never also refundable."""
    product = make_product(price="1000", stock=50)
    till, office = client_for(cashier), client_for(accountant)
    shift = start_shift(till)
    kept = sell(till, [(product, 10)], [(shop.cash, 10000)]).data
    wrong = sell(till, [(product, 4)], [(shop.cash, 4000)]).data
    office.post(f"/api/v1/sales/{wrong['id']}/void/", {"reason": "entered twice"}, format="json")
    assert refund(office, wrong, [(0, 1, True)], shop.cash).data["code"] == "sale_voided"
    refund(office, kept, [(0, 2, True)], shop.cash)
    day = close(till, shift["id"], 8000).data["day"]
    assert (day["gross_sales"], day["voids"], day["refunds"], day["net_sales"]) == ("14000.00", "4000.00", "2000.00", "8000.00")
    assert Sale.objects.count() == 2  # the cancelled sale stays on record


# --- Formal correction of a closed day ------------------------------------------

def test_at_sales_05_owner_correction_recalculates_later_days(cashier, accountant, owner, shop, make_product, set_today):
    product = make_product(price="1000", stock=5000)
    till = client_for(cashier)
    sale = None
    for day, amount in ((D1, 300000), (D2, 200000)):
        set_today(day)
        shift = start_shift(till)
        made = sell(till, [(product, amount // 1000)], [(shop.cash, amount)]).data
        sale = sale or made
        close(till, shift["id"], amount)
    set_today(D3)
    start_shift(till)  # day 3 is open with opening 500,000
    day1 = BusinessDay.objects.get(date=D1)
    body = {"request_key": str(uuid.uuid4()), "amount": "-50000", "reason": "Sale recorded twice in error", "sale": sale["id"]}

    assert client_for(accountant).post(f"/api/v1/days/{day1.pk}/corrections/", body, format="json").status_code == 403
    assert till.post(f"/api/v1/days/{day1.pk}/corrections/", body, format="json").status_code == 403
    office = client_for(owner)
    assert office.post(f"/api/v1/days/{day1.pk}/corrections/", body | {"reason": "oops"}, format="json").status_code == 400
    open_day = BusinessDay.objects.get(date=D3)
    assert office.post(f"/api/v1/days/{open_day.pk}/corrections/", body, format="json").data["code"] == "day_open"

    done = office.post(f"/api/v1/days/{day1.pk}/corrections/", body, format="json")
    again = office.post(f"/api/v1/days/{day1.pk}/corrections/", body, format="json")
    assert (done.status_code, again.status_code) == (201, 200)
    assert DayCorrection.objects.count() == 1

    chain = [(d.opening_cumulative_sales, d.net_sales, d.closing_cumulative_sales) for d in BusinessDay.objects.order_by("date")]
    # day 1 corrected; day 2 and the open day 3 follow, so opening always equals the previous closing
    assert chain == [(0, 250000, 250000), (250000, 200000, 450000), (450000, 0, None)]
    record = DayCorrection.objects.get()
    assert (record.net_sales_before, record.net_sales_after, record.closing_before, record.closing_after) == (300000, 250000, 300000, 250000)
    assert (record.authorised_by, record.sale_id, record.reason) == (owner, sale["id"], "Sale recorded twice in error")
    assert done.data["adjustments"] == "-50000.00" and done.data["gross_sales"] == "300000.00"  # original gross kept
    assert done.data["corrections"][0]["closing_before"] == "300000.00"
    log = AuditLog.objects.get(action="day.corrected")
    assert log.reason == "Sale recorded twice in error" and len(log.after["later_days"]) == 2


# --- Receiving stock ------------------------------------------------------------

def test_at_stk_01_02_03_physical_stock_carries_forward(cashier, accountant, shop, make_product, set_today):
    product = make_product(price="1000", stock=100)
    till, office = client_for(cashier), client_for(accountant)
    set_today(D1)
    shift = start_shift(till)
    assert receive(office, [(product, 20, "700")], reference="INV-88").status_code == 201
    sell(till, [(product, 45)], [(shop.cash, 45000)])
    close(till, shift["id"], 45000)
    assert stock_of(product) == 75  # AT-STK-01: 100 + 20 − 45

    set_today(D2)
    shift = start_shift(till)
    sell(till, [(product, 15)], [(shop.cash, 15000)])
    close(till, shift["id"], 15000)

    def report(day):
        rows = office.get(f"/api/v1/reports/stock-daily/?date_from={day}&date_to={day}").data["rows"]
        return rows[0]

    one, two = report(D1), report(D2)
    assert (one["opening"], one["received"], one["sold"], one["closing"], one["variance"]) == ("100", "20", "45", "75", "0")
    assert (two["opening"], two["sold"], two["closing"]) == ("75", "15", "60")  # AT-STK-02 and AT-STK-03
    assert stock_of(product) == 60


def test_receiving_rules_and_retry(accountant, cashier, shop, make_product):
    a, b = make_product("A", stock=5), make_product("B")
    office = client_for(accountant)
    assert receive(client_for(cashier), [(a, 1, None)]).status_code == 403
    assert receive(office, [(a, 0, None)]).status_code == 400
    assert receive(office, [(a, 1, None), (a, 2, None)]).status_code == 400
    key = str(uuid.uuid4())
    first = receive(office, [(a, 24, "3750"), (b, 12, None)], request_key=key, update_cost_price=True)
    retry = receive(office, [(a, 24, "3750"), (b, 12, None)], request_key=key, update_cost_price=True)
    assert (first.status_code, retry.status_code) == (201, 200) and retry.data["id"] == first.data["id"]
    assert (stock_of(a), stock_of(b)) == (29, 12)  # AT-STK-04: the retry did not post again
    assert InventoryMovement.objects.filter(movement_type="RECEIPT").count() == 2
    assert first.data["total_cost"] is None  # one line had no cost, so no misleading total is stored
    a.refresh_from_db()
    assert a.cost_price == Decimal("3750")
    assert first.data["supplier_name"] == "" and first.data["reference"] == ""  # nothing invented (FR-PUR-05)
    assert AuditLog.objects.filter(action="stock.received").count() == 1


# --- Expenses -------------------------------------------------------------------

def test_expenses_never_touch_cumulative_sales_but_drawer_cash_is_tracked(cashier, accountant, shop, make_product):
    product = make_product(price="1000", stock=100)
    till, office = client_for(cashier), client_for(accountant)
    shift = start_shift(till, "10000")
    sell(till, [(product, 20)], [(shop.cash, 20000)])

    def spend(amount, method, **extra):
        body = {"request_key": str(uuid.uuid4()), "category": "Transport", "description": "Boda for delivery",
                "amount": str(amount), "method": method.pk}
        return office.post("/api/v1/expenses/", body | extra, format="json")

    assert till.post("/api/v1/expenses/", {}, format="json").status_code == 403
    from_drawer = spend(3000, shop.cash, shift=shift["id"])
    assert from_drawer.status_code == 201 and from_drawer.data["paid_from_drawer_of"] == "Cashier"
    assert spend(50000, shop.bank).status_code == 201  # paid from the bank: nothing to do with the drawer
    assert spend(1000, shop.momo, shift=shift["id"]).data["code"] == "not_cash"
    assert spend(0, shop.cash).status_code == 400

    figures = till.get("/api/v1/day/current/").data["shift_figures"]
    assert figures["cash_paid_out"] == "3000.00" and figures["expected_cash"] == "27000.00"

    cancelled = office.post(f"/api/v1/expenses/{from_drawer.data['id']}/void/", {"reason": "entered by mistake"}, format="json")
    assert cancelled.data["status"] == "VOIDED"
    assert till.get("/api/v1/day/current/").data["shift_figures"]["expected_cash"] == "30000.00"
    spend(2500, shop.cash, shift=shift["id"])

    closed = close(till, shift["id"], 27500).data
    assert (closed["cash_paid_out"], closed["expected_cash"], closed["cash_variance"]) == ("2500.00", "27500.00", "0.00")
    assert closed["day"]["net_sales"] == closed["day"]["closing_cumulative_sales"] == "20000.00"  # expenses not included
    assert office.delete(f"/api/v1/expenses/{from_drawer.data['id']}/").status_code in (404, 405)


# --- Reports --------------------------------------------------------------------

def test_reports_reconcile_with_each_other_and_the_records(cashier, cashier2, accountant, shop, make_product, set_today):
    from django.db.models import Sum

    a, b = make_product("Konyagi", "1000", 100), make_product("Safari", "2500", 100)
    one, two, office = client_for(cashier), client_for(cashier2), client_for(accountant)
    set_today(D1)
    s1, s2 = start_shift(one), start_shift(two)
    kept = sell(one, [(a, 10), (b, 2)], [(shop.cash, 15000)]).data
    sell(two, [(b, 4)], [(shop.cash, 4000), (shop.momo, 6000)])
    wrong = sell(two, [(a, 3)], [(shop.cash, 3000)]).data
    office.post(f"/api/v1/sales/{wrong['id']}/void/", {"reason": "wrong product"}, format="json")
    refund(office, kept, [(0, 1, True)], shop.cash, shift=s1["id"])
    close(one, s1["id"], 14000)
    close(two, s2["id"], 4000)

    def get(name):
        response = office.get(f"/api/v1/reports/{name}/?date_from={D1}&date_to={D1}")
        assert response.status_code == 200, (name, response.data)
        return response.data

    daily = get("daily-sales")
    day = BusinessDay.objects.get()
    assert daily["rows"][0]["net_sales"] == "24000" and Decimal(daily["totals"]["net_sales"]) == day.net_sales == 24000
    assert (daily["rows"][0]["gross_sales"], daily["rows"][0]["voids"], daily["rows"][0]["refunds"]) == ("28000", "3000", "1000")

    by_product = get("sales-by-product")
    assert Decimal(by_product["totals"]["net_value"]) == day.net_sales
    assert {r["product"]: (r["quantity"], r["net_value"]) for r in by_product["rows"]} == {"Safari": ("6", "15000"), "Konyagi": ("10", "9000")}

    by_cashier = get("sales-by-cashier")
    assert Decimal(by_cashier["totals"]["value"]) == Sale.objects.filter(status="COMPLETED").aggregate(t=Sum("total"))["t"] == 25000
    assert by_cashier["totals"]["cancelled_value"] == "3000"

    payments = get("payment-summary")
    assert {r["method"]: r["net"] for r in payments["rows"]} == {"Cash": "18000", "Mobile Money": "6000"}
    assert Decimal(payments["totals"]["net"]) == day.net_sales

    closings = get("closings")
    assert Decimal(closings["totals"]["sales"]) == 25000 and closings["totals"]["variance"] == "0"

    stock = office.get("/api/v1/reports/stock-on-hand/").data
    assert {r["product"]: r["quantity"] for r in stock["rows"]} == {"Konyagi": "91", "Safari": "94"}
    assert Decimal(stock["totals"]["stock_value"]) == 185000  # 185 units at the test cost of 1,000


def test_report_export_and_access(cashier, owner, shop, make_product):
    make_product("Konyagi", stock=3, reorder_point=Decimal("5"), target_stock=Decimal("24"))
    office = client_for(owner)
    listed = office.get("/api/v1/reports/").data
    assert len(listed) == 21  # existing reports plus the damage register and four damage summaries
    for report in listed:
        assert office.get(f"/api/v1/reports/{report['key']}/").status_code == 200, report["key"]
        assert client_for(cashier).get(f"/api/v1/reports/{report['key']}/").status_code == 403  # incl. cost and financial reports
    low = office.get("/api/v1/reports/low-stock/").data["rows"]
    assert (low[0]["status"], low[0]["suggested_order"]) == ("Low stock", "21")
    csv_file = office.get("/api/v1/reports/low-stock/?download=csv")
    assert csv_file.status_code == 200 and csv_file["Content-Type"].startswith("text/csv")
    assert "attachment" in csv_file["Content-Disposition"]
    text = csv_file.content.decode("utf-8-sig")
    assert text.splitlines()[0].startswith("Code,Product,Counted by,In stock") and "Konyagi" in text
    assert AuditLog.objects.filter(action="report.exported").count() == 1
    assert office.get("/api/v1/reports/no-such-report/").status_code == 404
    assert office.get("/api/v1/reports/daily-sales/?date_from=2026-13-01").status_code == 400
