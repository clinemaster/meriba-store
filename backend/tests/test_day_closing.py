"""Shifts, cash reconciliation and the cumulative monetary sales balance (AT-11..13, AT-SALES-01..04, AT-UX-05)."""
from datetime import date
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction

from core.models import AuditLog
from trading.models import BusinessDay, CashierShift

from .conftest import client_for, sell, start_shift

D1, D2, D3, D5 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4), date(2026, 11, 6)


def close(client, shift_id, counted, note=""):
    return client.post(f"/api/v1/shifts/{shift_id}/close/", {"counted_cash": str(counted), "note": note, "payments_reviewed": True}, format="json")


def trade_day(client, shop, product, amount, counted=None):
    """Start a shift, sell `amount` worth for cash, close with the exact cash. Returns the closed shift."""
    shift = start_shift(client)
    if amount:
        assert sell(client, [(product, amount // 1000)], [(shop.cash, amount)]).status_code == 201
    response = close(client, shift["id"], amount if counted is None else counted)
    assert response.status_code == 200, response.data
    return response.data


def test_cannot_start_before_the_owner_goes_live(cashier, shop):
    shop.cfg.went_live_at = None
    shop.cfg.save()
    response = client_for(cashier).post("/api/v1/day/start/", {"opening_float": "0"}, format="json")
    assert response.status_code == 409 and response.data["code"] == "not_live"


def test_start_day_is_repeat_safe_and_shows_opening_figures_separately(cashier, shop, set_today):
    set_today(D1)
    shop.cfg.opening_cumulative_sales = Decimal("1250000")
    shop.cfg.save()
    client = client_for(cashier)
    assert client.get("/api/v1/day/current/").data["next_opening_cumulative_sales"] == "1250000.00"
    first = client.post("/api/v1/day/start/", {"opening_float": "100000"}, format="json")
    second = client.post("/api/v1/day/start/", {"opening_float": "999"}, format="json")
    assert (first.status_code, second.status_code) == (201, 200) and first.data["id"] == second.data["id"]
    assert BusinessDay.objects.count() == 1 and CashierShift.objects.count() == 1
    now = client.get("/api/v1/day/current/").data
    assert now["day"]["opening_cumulative_sales"] == "1250000.00"  # sales balance
    assert now["shift"]["opening_float"] == "100000.00"  # cash float: a different thing
    assert now["shift_figures"]["expected_cash"] == "100000.00"


@pytest.mark.parametrize("counted,variance,status", [
    ("580000", "0.00", "BALANCED"),        # AT-11
    ("570000", "-10000.00", "DISCREPANCY"),  # AT-12 shortage
    ("585000", "5000.00", "DISCREPANCY"),    # AT-13 overage
])
def test_at11_12_13_cash_variance(cashier, shop, make_product, counted, variance, status):
    product = make_product(price="1000", stock=1000)
    client = client_for(cashier)
    shift = start_shift(client, "100000")
    assert sell(client, [(product, 480)], [(shop.cash, 480000)]).status_code == 201
    preview = client.get(f"/api/v1/shifts/{shift['id']}/").data["figures"]
    assert preview["expected_cash"] == "580000.00"
    if status == "DISCREPANCY":
        refused = close(client, shift["id"], counted)
        assert refused.status_code == 400 and refused.data["code"] == "variance_needs_note"
        assert CashierShift.objects.get().status == "OPEN"
    done = close(client, shift["id"], counted, "counted twice")
    assert done.status_code == 200
    assert (done.data["expected_cash"], done.data["cash_variance"], done.data["status"]) == ("580000.00", variance, status)


def test_tolerance_treats_small_differences_as_balanced(cashier, shop, make_product):
    shop.cfg.cash_variance_tolerance = Decimal("500")
    shop.cfg.save()
    closed = trade_day(client_for(cashier), shop, make_product(price="1000", stock=50), 10000, counted=9600)
    assert closed["status"] == "BALANCED" and closed["cash_variance"] == "-400.00"


def test_at_sales_01_to_03_cumulative_balance_carries_forward(cashier, owner, shop, make_product, set_today):
    product = make_product(price="1000", stock=5000)
    client = client_for(cashier)
    expected = [(D1, 300000, "0.00", "300000.00"), (D2, 200000, "300000.00", "500000.00"), (D3, 150000, "500000.00", "650000.00")]
    for day, net, opening, closing in expected:
        set_today(day)
        closed = trade_day(client, shop, product, net)
        assert closed["day"]["status"] == "CLOSED"
        assert (closed["day"]["opening_cumulative_sales"], closed["day"]["net_sales"], closed["day"]["closing_cumulative_sales"]) == (
            opening, f"{net}.00", closing)
    history = client_for(owner).get("/api/v1/days/").data["results"]
    assert [(d["date"], d["closing_cumulative_sales"]) for d in history] == [
        ("2026-11-04", "650000.00"), ("2026-11-03", "500000.00"), ("2026-11-02", "300000.00")]
    days = list(BusinessDay.objects.order_by("date"))
    assert days[1].previous_day == days[0] and days[2].previous_day == days[1]
    assert AuditLog.objects.filter(action="day.closed").count() == 3


def test_days_without_trading_are_skipped_not_zeroed(cashier, shop, make_product, set_today):
    product = make_product(price="1000", stock=500)
    client = client_for(cashier)
    set_today(D1)
    trade_day(client, shop, product, 300000)
    set_today(D5)  # shop was shut for three days
    assert start_shift(client)["business_date"] == "2026-11-06"
    assert BusinessDay.objects.get(date=D5).opening_cumulative_sales == 300000
    assert BusinessDay.objects.count() == 2


def test_closing_balance_cannot_be_carried_forward_twice(cashier, owner, shop, make_product, set_today):
    set_today(D1)
    trade_day(client_for(cashier), shop, make_product(price="1000", stock=500), 300000)
    first = BusinessDay.objects.get()
    BusinessDay.objects.create(branch=shop.branch, date=D2, previous_day=first, opening_cumulative_sales=300000,
                               opened_by=owner, status="CLOSED", closing_cumulative_sales=300000)
    with pytest.raises(IntegrityError), transaction.atomic():
        BusinessDay.objects.create(branch=shop.branch, date=D3, previous_day=first, opening_cumulative_sales=300000,
                                   opened_by=owner, status="CLOSED", closing_cumulative_sales=300000)


def test_database_refuses_a_closing_balance_that_does_not_add_up(owner, shop):
    with pytest.raises(IntegrityError), transaction.atomic():
        BusinessDay.objects.create(branch=shop.branch, date=D1, opening_cumulative_sales=100, net_sales=50, gross_sales=50,
                                   opened_by=owner, status="CLOSED", closing_cumulative_sales=999)
    with pytest.raises(IntegrityError), transaction.atomic():  # only one open day at a time
        BusinessDay.objects.create(branch=shop.branch, date=D1, opening_cumulative_sales=0, opened_by=owner)
        BusinessDay.objects.create(branch=shop.branch, date=D2, opening_cumulative_sales=0, opened_by=owner)


def test_at_sales_04_cumulative_sales_is_separate_from_cash(cashier, shop, make_product, set_today):
    """Float, cash counted, shortages and mobile money must never leak into the cumulative sales balance."""
    set_today(D1)
    product = make_product(price="1000", stock=500)
    client = client_for(cashier)
    shift = start_shift(client, "100000")
    sell(client, [(product, 200)], [(shop.cash, 150000), (shop.momo, 50000)])
    closed = close(client, shift["id"], 240000, "10,000 missing").data
    assert closed["expected_cash"] == "250000.00"       # 100,000 float + 150,000 cash
    assert closed["cash_variance"] == "-10000.00"
    assert closed["sales_total"] == "200000.00"
    assert closed["day"]["net_sales"] == "200000.00"    # all sales, whatever the payment method
    assert closed["day"]["closing_cumulative_sales"] == "200000.00"  # not 240,000 and not 250,000
    assert {t["name"]: (t["amount"], t["is_verified"]) for t in closed["payment_totals"]} == {
        "Cash": ("150000.00", True), "Mobile Money": ("50000.00", False)}


def test_cancelled_sales_reduce_net_sales(cashier, accountant, shop, make_product, set_today):
    set_today(D1)
    product = make_product(price="1000", stock=500)
    client = client_for(cashier)
    shift = start_shift(client)
    sell(client, [(product, 100)], [(shop.cash, 100000)])
    wrong = sell(client, [(product, 30)], [(shop.cash, 30000)]).data
    client_for(accountant).post(f"/api/v1/sales/{wrong['id']}/void/", {"reason": "rung up twice"}, format="json")
    day = close(client, shift["id"], 100000).data["day"]
    assert (day["gross_sales"], day["voids"], day["net_sales"], day["closing_cumulative_sales"]) == (
        "130000.00", "30000.00", "100000.00", "100000.00")


def test_closed_day_is_locked(cashier, accountant, shop, make_product, set_today):
    set_today(D1)
    product = make_product(price="1000", stock=500)
    client = client_for(cashier)
    shift = start_shift(client)
    sale = sell(client, [(product, 10)], [(shop.cash, 10000)]).data
    first = close(client, shift["id"], 10000)
    again = close(client, shift["id"], 99999)  # repeated click: nothing changes
    assert again.status_code == 200 and again.data["counted_cash"] == first.data["counted_cash"] == "10000.00"
    assert AuditLog.objects.filter(action="shift.closed").count() == 1

    assert sell(client, [(product, 1)], [(shop.cash, 1000)]).data["code"] == "no_open_shift"
    restart = client.post("/api/v1/day/start/", {"opening_float": "0"}, format="json")
    assert restart.status_code == 409 and restart.data["code"] == "day_already_closed"
    void = client_for(accountant).post(f"/api/v1/sales/{sale['id']}/void/", {"reason": "too late now"}, format="json")
    assert void.status_code == 409 and void.data["code"] == "day_closed"
    for url in ("/api/v1/days/", f"/api/v1/shifts/{shift['id']}/"):
        assert client_for(accountant).patch(url, {"net_sales": "1"}, format="json").status_code == 405
    assert BusinessDay.objects.get().closing_cumulative_sales == 10000


def test_unclosed_previous_day_must_be_closed_first(cashier, cashier2, accountant, shop, make_product, set_today):
    set_today(D1)
    client = client_for(cashier)
    shift = start_shift(client)
    sell(client, [(make_product(price="1000", stock=50), 5)], [(shop.cash, 5000)])
    set_today(D2)
    blocked = client_for(cashier2).post("/api/v1/day/start/", {"opening_float": "0"}, format="json")
    assert blocked.status_code == 409 and blocked.data["code"] == "previous_day_open"
    assert client.get("/api/v1/day/current/").data["day_needs_closing"] is True
    # the Accountant can close it on the absent cashier's behalf; the action is recorded under their name
    assert close(client_for(accountant), shift["id"], 5000).status_code == 200
    assert AuditLog.objects.get(action="shift.closed").actor == accountant
    assert start_shift(client_for(cashier2))["business_date"] == "2026-11-03"
    assert BusinessDay.objects.get(date=D2).opening_cumulative_sales == 5000


def test_review_needs_another_person_and_verified_non_cash(cashier, accountant, owner, shop, make_product, set_today):
    set_today(D1)
    product = make_product(price="1000", stock=500)
    client = client_for(cashier)
    shift = start_shift(client)
    sell(client, [(product, 20)], [(shop.momo, 20000)])
    closed = close(client, shift["id"], 0).data
    assert closed["status"] == "PENDING"  # FR-REC-09: non-cash still to be checked
    office = client_for(accountant)
    unverified = office.post(f"/api/v1/shifts/{shift['id']}/review/", {}, format="json")
    assert unverified.status_code == 400 and unverified.data["code"] == "payments_unverified"
    ok = office.post(f"/api/v1/shifts/{shift['id']}/review/", {"verified_methods": [shop.momo.pk]}, format="json")
    assert ok.status_code == 200 and ok.data["status"] == "APPROVED" and ok.data["reviewed_by_name"] == "Accountant"
    from sales.models import Payment
    assert Payment.objects.get().status == "VERIFIED"

    # separation of duties: whoever ran the till cannot approve it
    set_today(D2)
    own = client_for(owner)
    own_shift = start_shift(own)
    close(own, own_shift["id"], 0)
    assert own.post(f"/api/v1/shifts/{own_shift['id']}/review/", {}, format="json").data["code"] == "self_review"


def test_discrepancy_review_requires_a_note(cashier, accountant, shop, make_product):
    client = client_for(cashier)
    shift = start_shift(client)
    sell(client, [(make_product(price="1000", stock=50), 10)], [(shop.cash, 10000)])
    close(client, shift["id"], 9000, "till was short")
    office = client_for(accountant)
    assert office.post(f"/api/v1/shifts/{shift['id']}/review/", {}, format="json").data["code"] == "note_required"
    done = office.post(f"/api/v1/shifts/{shift['id']}/review/", {"note": "cashier repaid 1,000"}, format="json")
    assert done.data["status"] == "APPROVED" and done.data["cash_variance"] == "-1000.00"  # history is kept


def test_day_report_reconciles_with_its_sales(cashier, cashier2, shop, make_product, set_today):
    from django.db.models import Sum
    from sales.models import Payment, Sale

    set_today(D1)
    product = make_product(price="1000", stock=500)
    one, two = client_for(cashier), client_for(cashier2)
    s1, s2 = start_shift(one), start_shift(two)
    sell(one, [(product, 7)], [(shop.cash, 7000)])
    sell(two, [(product, 5)], [(shop.cash, 2000), (shop.bank, 3000)])
    close(one, s1["id"], 7000)
    assert BusinessDay.objects.get().status == "OPEN"  # another till is still open
    day = close(two, s2["id"], 2000).data["day"]
    assert day["status"] == "CLOSED"
    sales_total = Sale.objects.filter(status="COMPLETED").aggregate(t=Sum("total"))["t"]
    payments_total = Payment.objects.exclude(status="REVERSED").aggregate(t=Sum("amount"))["t"]
    shifts_total = CashierShift.objects.aggregate(t=Sum("sales_total"))["t"]
    assert Decimal(day["net_sales"]) == sales_total == payments_total == shifts_total == 12000
