"""The Owner may change a shift's cash float while it is open, and the open day's opening cumulative sales balance.
Every change needs a reason, is Owner only, and is recorded; the balance chain stays consistent."""
import uuid
from datetime import date
from decimal import Decimal

import pytest

from core.models import AuditLog
from trading.models import BusinessDay, OpeningBalanceChange

from .conftest import client_for, sell, start_shift

D1, D2, D3 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4)
REASON = "Cashier typed the wrong amount"


def close(client, shift_id, counted, note=""):
    return client.post(f"/api/v1/shifts/{shift_id}/close/", {"counted_cash": str(counted), "note": note, "payments_reviewed": True}, format="json")


def change_float(client, shift_id, amount, reason=REASON):
    return client.post(f"/api/v1/shifts/{shift_id}/float/", {"opening_float": str(amount), "reason": reason}, format="json")


def change_opening(client, day_id, amount, reason=REASON):
    return client.post(f"/api/v1/days/{day_id}/opening-balance/", {"opening_cumulative_sales": str(amount), "reason": reason}, format="json")


# --- Cash float -------------------------------------------------------------------

def test_owner_changes_an_open_shifts_float_and_expected_cash_follows(owner, cashier, shop, make_product, set_today):
    set_today(D1)
    product = make_product(price="1000", stock=100)
    till = client_for(cashier)
    shift = start_shift(till, "10000")
    sell(till, [(product, 5)], [(shop.cash, 5000)])

    response = change_float(client_for(owner), shift["id"], "20000")
    assert response.status_code == 200 and response.data["opening_float"] == "20000.00"
    assert till.get("/api/v1/day/current/").data["shift_figures"]["expected_cash"] == "25000.00"

    log = AuditLog.objects.get(action="shift.float_changed")
    assert (log.reason, log.before, log.after) == (REASON, {"opening_float": "10000.00"}, {"opening_float": "20000.00"})
    assert log.actor == owner

    closed = close(till, shift["id"], 25000)
    assert closed.data["status"] == "BALANCED" and closed.data["cash_variance"] == "0.00"


def test_only_the_owner_changes_a_float(accountant, cashier, set_today):
    set_today(D1)
    till = client_for(cashier)
    shift = start_shift(till, "10000")
    assert change_float(client_for(accountant), shift["id"], "1").status_code == 403
    assert change_float(till, shift["id"], "1").status_code == 403


@pytest.mark.parametrize("amount,reason,code", [
    ("20000", "oops", "reason_required"),
    ("10000", REASON, "no_change"),
])
def test_float_change_needs_a_reason_and_a_new_amount(owner, cashier, set_today, amount, reason, code):
    set_today(D1)
    shift = start_shift(client_for(cashier), "10000")
    response = change_float(client_for(owner), shift["id"], amount, reason)
    assert response.status_code == 400 and response.data["code"] == code


def test_float_cannot_be_negative(owner, cashier, set_today):
    set_today(D1)
    shift = start_shift(client_for(cashier), "10000")
    assert change_float(client_for(owner), shift["id"], "-1").status_code == 400


def test_a_closed_shifts_float_cannot_be_changed(owner, cashier, set_today):
    set_today(D1)
    till = client_for(cashier)
    shift = start_shift(till, "10000")
    close(till, shift["id"], 10000)
    response = change_float(client_for(owner), shift["id"], "20000")
    assert response.status_code == 409 and response.data["code"] == "shift_closed"
    assert not AuditLog.objects.filter(action="shift.float_changed").exists()


# --- Opening cumulative sales balance ----------------------------------------------

def test_owner_changes_the_open_days_opening_balance(owner, cashier, shop, make_product, set_today):
    set_today(D1)
    product = make_product(price="1000", stock=100)
    till = client_for(cashier)
    shift = start_shift(till)
    sell(till, [(product, 3)], [(shop.cash, 3000)])
    day = BusinessDay.objects.get()

    response = change_opening(client_for(owner), day.pk, "500000")
    assert response.status_code == 200 and response.data["opening_cumulative_sales"] == "500000.00"
    assert response.data["opening_changes"][0]["opening_before"] == "0.00"
    figures = client_for(owner).get("/api/v1/day/current/").data["day_figures"]
    assert (figures["opening_cumulative_sales"], figures["closing_cumulative_sales"]) == ("500000.00", "503000.00")

    close(till, shift["id"], 3000)
    day.refresh_from_db()
    assert (day.opening_cumulative_sales, day.closing_cumulative_sales) == (500000, 503000)
    change = OpeningBalanceChange.objects.get()
    assert (change.opening_before, change.opening_after, change.reason, change.authorised_by) == (0, 500000, REASON, owner)
    assert AuditLog.objects.get(action="day.opening_changed").reason == REASON


def test_only_the_owner_changes_the_opening_balance(accountant, cashier, set_today):
    set_today(D1)
    start_shift(client_for(cashier))
    day = BusinessDay.objects.get()
    assert change_opening(client_for(accountant), day.pk, "1").status_code == 403
    assert change_opening(client_for(cashier), day.pk, "1").status_code == 403


def test_a_closed_days_opening_balance_is_changed_only_by_a_correction(owner, cashier, set_today):
    set_today(D1)
    till = client_for(cashier)
    close(till, start_shift(till)["id"], 0)
    day = BusinessDay.objects.get()
    response = change_opening(client_for(owner), day.pk, "1000")
    assert response.status_code == 409 and response.data["code"] == "day_closed"


def test_opening_change_needs_a_reason_and_a_new_amount(owner, cashier, set_today):
    set_today(D1)
    start_shift(client_for(cashier))
    day = BusinessDay.objects.get()
    office = client_for(owner)
    assert change_opening(office, day.pk, "1000", "short").data["code"] == "reason_required"
    assert change_opening(office, day.pk, "0").data["code"] == "no_change"
    assert change_opening(office, day.pk, "-5").status_code == 400
    assert not OpeningBalanceChange.objects.exists()


def test_owner_sets_a_different_opening_balance_when_starting_the_day(owner, cashier, set_today):
    set_today(D1)
    body = {"opening_float": "5000", "opening_cumulative_sales": "750000", "opening_reason": REASON}
    assert client_for(owner).post("/api/v1/day/start/", body, format="json").status_code == 201
    day = BusinessDay.objects.get()
    assert day.opening_cumulative_sales == 750000
    assert OpeningBalanceChange.objects.get().opening_before == 0
    assert AuditLog.objects.filter(action__in=["day.opened", "day.opening_changed"]).count() == 2


def test_start_day_without_a_change_records_none(owner, set_today):
    set_today(D1)
    body = {"opening_float": "0", "opening_cumulative_sales": "0", "opening_reason": ""}
    assert client_for(owner).post("/api/v1/day/start/", body, format="json").status_code == 201
    assert not OpeningBalanceChange.objects.exists()


def test_start_day_opening_change_needs_a_reason_and_starts_nothing_without_one(owner, set_today):
    set_today(D1)
    body = {"opening_float": "0", "opening_cumulative_sales": "750000", "opening_reason": "no"}
    response = client_for(owner).post("/api/v1/day/start/", body, format="json")
    assert response.status_code == 400 and response.data["code"] == "reason_required"
    assert not BusinessDay.objects.exists()


def test_only_the_owner_can_start_with_a_different_opening_balance(accountant, cashier, set_today):
    set_today(D1)
    body = {"opening_float": "0", "opening_cumulative_sales": "750000", "opening_reason": REASON}
    for user in (accountant, cashier):
        response = client_for(user).post("/api/v1/day/start/", body, format="json")
        assert response.status_code == 403 and response.data["code"] == "owner_only"
    assert not BusinessDay.objects.exists()


def test_start_day_refuses_an_opening_change_once_the_day_is_open(owner, cashier, set_today):
    set_today(D1)
    start_shift(client_for(cashier))
    body = {"opening_float": "0", "opening_cumulative_sales": "750000", "opening_reason": REASON}
    response = client_for(owner).post("/api/v1/day/start/", body, format="json")
    assert response.status_code == 409 and response.data["code"] == "day_already_open"
    assert BusinessDay.objects.get().opening_cumulative_sales == 0


def test_a_later_correction_keeps_the_owners_opening_change(owner, cashier, shop, make_product, set_today):
    product = make_product(price="1000", stock=1000)
    till, office = client_for(cashier), client_for(owner)
    set_today(D1)
    shift = start_shift(till)
    sell(till, [(product, 100)], [(shop.cash, 100000)])
    close(till, shift["id"], 100000)

    set_today(D2)
    shift = start_shift(till)
    day2 = BusinessDay.objects.get(date=D2)
    change_opening(office, day2.pk, "150000")  # carried 100,000; Owner says 150,000
    sell(till, [(product, 10)], [(shop.cash, 10000)])
    close(till, shift["id"], 10000)

    set_today(D3)
    start_shift(till)

    day1 = BusinessDay.objects.get(date=D1)
    body = {"request_key": str(uuid.uuid4()), "amount": "-20000", "reason": "Sale recorded twice in error"}
    assert office.post(f"/api/v1/days/{day1.pk}/corrections/", body, format="json").status_code == 201

    chain = [(d.opening_cumulative_sales, d.net_sales, d.closing_cumulative_sales) for d in BusinessDay.objects.order_by("date")]
    # Day 1 drops by 20,000; day 2 opens at the new carried 80,000 plus the Owner's +50,000.
    assert chain == [(0, 80000, 80000), (130000, 10000, 140000), (140000, 0, None)]
    assert sum(c.opening_after - c.opening_before for c in OpeningBalanceChange.objects.all()) == Decimal("50000")
