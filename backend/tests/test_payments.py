"""Payment categories, providers, split payments, reconciliation, drill-down, exports, closing and audit."""
import importlib
import uuid
from decimal import Decimal
from io import BytesIO

import pytest
from django.apps import apps as live_apps

from core.models import AuditLog
from sales.models import Payment, PaymentMethod, PaymentProvider, Sale
from trading.models import BusinessDay, ShiftPaymentTotal

from .conftest import client_for, close_shift, sell, start_shift


@pytest.fixture
def till(cashier):
    client = client_for(cashier)
    start_shift(client)
    return client


def pay(method, amount, provider=None, reference=""):
    return {"method": method.pk, "amount": str(amount), "provider": getattr(provider, "pk", None), "reference": reference}


def sell_raw(client, product, quantity, payments, key=None):
    body = {"request_key": str(key or uuid.uuid4()), "items": [{"product": product.pk, "quantity": str(quantity)}], "payments": payments}
    return client.post("/api/v1/sales/", body, format="json")


def summary(client, day, **params):
    query = "&".join(f"{k}={v}" for k, v in {"date_from": day, "date_to": day, **params}.items())
    response = client.get(f"/api/v1/payment-summary/?{query}")
    assert response.status_code == 200, response.data
    return response.data


def category(data, method):
    return next(c for c in data["categories"] if c["id"] == method.pk)


def line(cat, name):
    return next(p for p in cat["providers"] if p["name"] == name)


def transactions(client, day, **params):
    query = "&".join(f"{k}={v}" for k, v in {"date_from": day, "date_to": day, **params}.items())
    response = client.get(f"/api/v1/payment-transactions/?{query}")
    assert response.status_code == 200, response.data
    return response.data


# --- Configuration ------------------------------------------------------------------------------------------

def test_owner_adds_categories_and_providers_without_code_changes(owner, accountant, cashier, shop):
    boss = client_for(owner)
    card = boss.post("/api/v1/payment-methods/", {"name": "Card", "icon": "card", "requires_provider": True, "description": "Visa and Mastercard"}, format="json")
    assert card.status_code == 201, card.data
    assert card.data["code"] == "card" and card.data["requires_provider"] is True
    visa = boss.post("/api/v1/payment-providers/", {"category": card.data["id"], "name": "  Visa   Debit "}, format="json")
    assert visa.status_code == 201 and visa.data["name"] == "Visa Debit" and visa.data["code"] == "visa-debit"
    tigo = boss.post("/api/v1/payment-providers/", {"category": shop.momo.pk, "name": "HaloPesa"}, format="json")
    assert tigo.status_code == 201 and tigo.data["sort_order"] == 4  # goes to the end of Mobile Money

    # Names are unique within a category, ignoring case, spaces and punctuation.
    assert boss.post("/api/v1/payment-providers/", {"category": shop.momo.pk, "name": "m pesa"}, format="json").status_code == 400
    assert boss.post("/api/v1/payment-providers/", {"category": shop.cash.pk, "name": "Till"}, format="json").status_code == 400  # cash has none
    assert boss.post("/api/v1/payment-methods/", {"name": "cash"}, format="json").status_code == 400
    assert boss.patch(f"/api/v1/payment-methods/{shop.cash.pk}/", {"requires_provider": True}, format="json").status_code == 400
    assert boss.patch(f"/api/v1/payment-methods/{shop.momo.pk}/", {"code": "momo"}, format="json").status_code == 400  # stable id

    # Only the Owner changes configuration; the Accountant reads everything; a cashier reads what is switched on.
    for user in (accountant, cashier):
        assert client_for(user).post("/api/v1/payment-providers/", {"category": shop.momo.pk, "name": "X"}, format="json").status_code == 403
        assert client_for(user).patch(f"/api/v1/payment-providers/{shop.mpesa.pk}/", {"is_active": False}, format="json").status_code == 403
        assert client_for(user).post("/api/v1/payment-methods/reorder/", {"ids": [1]}, format="json").status_code == 403
    assert boss.patch(f"/api/v1/payment-providers/{shop.nbc.pk}/", {"is_active": False}, format="json").status_code == 200
    office_banks = [p["name"] for p in category({"categories": client_for(accountant).get("/api/v1/payment-methods/").data}, shop.bank)["providers"]]
    till_banks = [p["name"] for p in category({"categories": client_for(cashier).get("/api/v1/payment-methods/").data}, shop.bank)["providers"]]
    assert office_banks == ["NMB", "CRDB", "NBC"] and till_banks == ["NMB", "CRDB"]
    assert AuditLog.objects.filter(action="payment_provider.switched_off").count() == 1
    assert AuditLog.objects.filter(action="payment_method.created").count() == 1


def test_reorder_delete_and_history(owner, accountant, cashier, till, shop, make_product):
    boss = client_for(owner)
    order = [shop.airtel.pk, shop.mpesa.pk, shop.mixx.pk]
    assert boss.post("/api/v1/payment-providers/reorder/", {"ids": order}, format="json").status_code == 200
    assert [p.pk for p in PaymentProvider.objects.filter(category=shop.momo).order_by("sort_order")] == order
    assert boss.post("/api/v1/payment-providers/reorder/", {"ids": [shop.airtel.pk, shop.nmb.pk]}, format="json").status_code == 400
    assert boss.post("/api/v1/payment-providers/reorder/", {"ids": order[:2]}, format="json").status_code == 400  # incomplete list

    unused = boss.post("/api/v1/payment-providers/", {"category": shop.bank.pk, "name": "Equity"}, format="json").data
    assert boss.delete(f"/api/v1/payment-providers/{unused['id']}/").status_code == 204
    sell(till, [(make_product(stock=5), 1)], [(shop.bank, 4500, shop.crdb)])
    used = boss.delete(f"/api/v1/payment-providers/{shop.crdb.pk}/")
    assert used.status_code == 409 and PaymentProvider.objects.filter(pk=shop.crdb.pk).exists()
    assert boss.delete(f"/api/v1/payment-methods/{shop.momo.pk}/").status_code == 409  # still has providers

    history = client_for(accountant).get("/api/v1/payment-providers/history/")
    assert history.status_code == 200
    assert {e["action"] for e in history.data["results"]} >= {"payment_provider.reordered", "payment_provider.created", "payment_provider.deleted"}
    assert client_for(cashier).get("/api/v1/payment-methods/history/").status_code == 403


def test_last_provider_of_a_required_category_cannot_be_switched_off(owner, shop):
    boss = client_for(owner)
    assert boss.patch(f"/api/v1/payment-providers/{shop.nmb.pk}/", {"is_active": False}, format="json").status_code == 200
    assert boss.patch(f"/api/v1/payment-providers/{shop.crdb.pk}/", {"is_active": False}, format="json").status_code == 200
    last = boss.patch(f"/api/v1/payment-providers/{shop.nbc.pk}/", {"is_active": False}, format="json")
    assert last.status_code == 409 and last.data["code"] == "last_provider"


# --- Selling ------------------------------------------------------------------------------------------------

def test_cash_needs_no_provider_mobile_money_and_bank_need_a_valid_one(till, owner, shop, make_product):
    product = make_product(price="10000", stock=50)
    assert sell_raw(till, product, 1, [pay(shop.cash, 10000)]).status_code == 201

    missing = sell_raw(till, product, 1, [pay(shop.momo, 10000)])
    assert missing.status_code == 400 and missing.data["code"] == "provider_required"
    assert "M-PESA" in missing.data["message"]
    assert sell_raw(till, product, 1, [pay(shop.bank, 10000)]).data["code"] == "provider_required"
    assert sell_raw(till, product, 1, [pay(shop.momo, 10000, shop.nmb)]).data["code"] == "provider_mismatch"

    ok = sell_raw(till, product, 1, [pay(shop.momo, 10000, shop.mixx, "QX12")])
    assert ok.status_code == 201
    assert (ok.data["payments"][0]["provider_name"], ok.data["payments"][0]["reference"]) == ("Mixx by Yas", "QX12")
    assert sell_raw(till, product, 1, [pay(shop.bank, 10000, shop.nbc)]).status_code == 201

    client_for(owner).patch(f"/api/v1/payment-providers/{shop.airtel.pk}/", {"is_active": False}, format="json")
    off = sell_raw(till, product, 1, [pay(shop.momo, 10000, shop.airtel)])
    assert off.status_code == 400 and off.data["code"] == "provider_inactive"
    client_for(owner).patch(f"/api/v1/payment-methods/{shop.bank.pk}/", {"is_active": False}, format="json")
    assert sell_raw(till, product, 1, [pay(shop.bank, 10000, shop.nmb)]).data["code"] == "method_inactive"
    assert Sale.objects.count() == 3


def test_split_payment_cash_mpesa_nmb(till, shop, make_product):
    product = make_product(price="50000", stock=5)
    sale = sell_raw(till, product, 1, [pay(shop.cash, 20000), pay(shop.momo, 20000, shop.mpesa, "MP1"), pay(shop.bank, 10000, shop.nmb, "NMB9")])
    assert sale.status_code == 201, sale.data
    assert [(p["method_name"], p["provider_name"], p["amount"]) for p in sale.data["payments"]] == [
        ("Cash", "", "20000.00"), ("Mobile Money", "M-PESA", "20000.00"), ("Bank Transfer", "NMB", "10000.00")]
    # Two different mobile money providers on one sale are fine; the same provider twice is not.
    two = sell_raw(till, product, 1, [pay(shop.momo, 30000, shop.mpesa), pay(shop.momo, 20000, shop.airtel)])
    assert two.status_code == 201
    twice = sell_raw(till, product, 1, [pay(shop.momo, 30000, shop.mpesa), pay(shop.momo, 20000, shop.mpesa)])
    assert twice.status_code == 400 and twice.data["code"] == "duplicate_method"
    short = sell_raw(till, product, 1, [pay(shop.momo, 30000, shop.mpesa), pay(shop.bank, 10000, shop.nmb)])
    assert short.status_code == 400 and short.data["code"] == "underpaid"  # never saved as a completed sale
    assert sell_raw(till, product, 1, [pay(shop.cash, -5), pay(shop.bank, 50000, shop.nmb)]).status_code == 400

    # A repeated click or retry with the same key saves nothing new.
    key = uuid.uuid4()
    body = [pay(shop.cash, 20000), pay(shop.momo, 30000, shop.mpesa)]
    assert sell_raw(till, product, 1, body, key).status_code == 201
    assert sell_raw(till, product, 1, body, key).status_code == 200
    assert Sale.objects.count() == 3 and Payment.objects.count() == 7


def test_change_is_taken_once_from_cash(till, shop, make_product):
    product = make_product(price="9000", stock=5)
    sale = sell_raw(till, product, 1, [pay(shop.momo, 4000, shop.mpesa), pay(shop.cash, 10000)]).data
    assert sale["change_due"] == "5000.00"
    assert {p["method_name"]: p["amount"] for p in sale["payments"]} == {"Mobile Money": "4000.00", "Cash": "5000.00"}


# --- Reconciliation, drill-down, exports ----------------------------------------------------------------

@pytest.fixture
def trading_day(till, shop, make_product):
    """The example in the brief: 10,000 of sales = Cash 3,000 + M-PESA 3,000 + Mixx 1,000 + Airtel 1,000 + NMB 1,000 + CRDB 1,000."""
    product = make_product(price="1000", stock=100)
    for payments in ([pay(shop.cash, 3000)], [pay(shop.momo, 2000, shop.mpesa)], [pay(shop.momo, 1000, shop.mpesa), pay(shop.momo, 1000, shop.mixx)],
                     [pay(shop.momo, 1000, shop.airtel, "=HYPERLINK(\"http://x\")")], [pay(shop.bank, 1000, shop.nmb), pay(shop.bank, 1000, shop.crdb)]):
        total = sum(Decimal(p["amount"]) for p in payments)
        assert sell_raw(till, product, int(total / 1000), payments).status_code == 201
    return BusinessDay.objects.get(status="OPEN").date.isoformat()


def test_provider_totals_add_up_to_categories_and_categories_to_collections(accountant, trading_day, shop):
    data = summary(client_for(accountant), trading_day)
    m = data["metrics"]
    assert (m["gross_sales"], m["net_sales"], m["payments_collected"], m["sale_count"]) == (Decimal("10000"), Decimal("10000"), Decimal("10000"), 5)
    cash, momo, bank = category(data, shop.cash), category(data, shop.momo), category(data, shop.bank)
    assert (cash["amount"], momo["amount"], bank["amount"]) == (Decimal("3000"), Decimal("5000"), Decimal("2000"))
    assert cash["providers"] == []
    assert {p["name"]: p["amount"] for p in momo["providers"]} == {"M-PESA": 3000, "Mixx by Yas": 1000, "Airtel Money": 1000}
    assert {p["name"]: p["amount"] for p in bank["providers"]} == {"NMB": 1000, "CRDB": 1000, "NBC": 0}
    assert line(momo, "M-PESA")["count"] == 2  # two payments; the split sale is still one sale
    assert data["checks"] == {"providers_match_categories": True, "categories_match_total": True, "reconciled": True}
    assert m["outstanding_receivables"] == 0 and m["reconciliation_difference"] == 0


def test_every_card_opens_a_list_with_the_same_total_and_exports_match(accountant, trading_day, shop):
    office = client_for(accountant)
    data = summary(office, trading_day)
    momo = category(data, shop.momo)
    cards = [({"category": c["id"]}, c["amount"]) for c in data["categories"]]
    cards += [({"category": momo["id"], "provider": p["id"]}, p["amount"]) for p in momo["providers"]]
    cards += [({}, data["metrics"]["payments_collected"])]
    for params, amount in cards:
        listed = transactions(office, trading_day, **params)
        assert Decimal(listed["totals"]["amount"]) == amount, params
        assert sum(Decimal(r["amount"]) for r in listed["results"]) == amount
    mpesa = transactions(office, trading_day, category=shop.momo.pk, provider=shop.mpesa.pk)
    assert {r["provider"] for r in mpesa["results"]} == {"M-PESA"} and mpesa["count"] == 2
    row = mpesa["results"][0]
    assert set(row) >= {"number", "receipt_number", "date_time", "cashier", "branch", "category", "provider", "amount", "reference", "status"}

    # Search, sorting and pagination run on the server.
    assert transactions(office, trading_day, search="HYPERLINK")["count"] == 1
    by_amount = transactions(office, trading_day, ordering="-amount", page_size=2)
    assert by_amount["pages"] == 4 and [r["amount"] for r in by_amount["results"]] == [Decimal("3000"), Decimal("2000")]
    assert office.get(f"/api/v1/payment-transactions/?date_from={trading_day}&ordering=password").status_code == 400

    csv_file = office.get(f"/api/v1/payment-transactions/?date_from={trading_day}&category={shop.momo.pk}&download=csv")
    text = csv_file.content.decode("utf-8-sig").splitlines()
    assert text[-1].startswith("TOTAL") and text[-1].split(",")[8] == "5000"
    assert any("'=HYPERLINK" in t for t in text)  # a typed reference can never run as a spreadsheet formula

    from openpyxl import load_workbook

    xlsx = office.get(f"/api/v1/payment-transactions/?date_from={trading_day}&category={shop.momo.pk}&download=xlsx")
    assert xlsx["Content-Type"].startswith("application/vnd.openxmlformats")
    sheet = load_workbook(BytesIO(xlsx.content)).active
    rows = list(sheet.values)
    assert rows[-1][0] == "TOTAL" and Decimal(str(rows[-1][8])) == 5000
    assert all(not (isinstance(v, str) and v.startswith("=")) for r in rows for v in r)
    assert AuditLog.objects.filter(action="report.exported").count() == 2


def test_cashier_sees_only_their_own_payments(cashier2, trading_day, shop, make_product):
    other = client_for(cashier2)
    start_shift(other)
    sell(other, [(make_product(price="7000", stock=5), 1)], [(shop.momo, 7000, shop.mpesa)])
    mine = summary(other, trading_day, cashier="")
    assert mine["metrics"]["payments_collected"] == 7000 and "cashiers" not in mine["options"]
    everyone = transactions(other, trading_day, cashier=1)
    assert everyone["count"] == 1  # asking for another cashier changes nothing
    assert other.get(f"/api/v1/payments/{Payment.objects.first().pk}/provider/").status_code in (403, 405)


def test_cancellations_and_refunds_are_counted_once(owner, accountant, till, shop, make_product):
    office = client_for(accountant)
    product = make_product(price="1000", stock=50)
    kept = sell_raw(till, product, 4, [pay(shop.momo, 4000, shop.mpesa)]).data
    voided = sell_raw(till, product, 2, [pay(shop.bank, 2000, shop.nmb)]).data
    sell_raw(till, product, 3, [pay(shop.cash, 3000)])
    assert office.post(f"/api/v1/sales/{voided['id']}/void/", {"reason": "Rang up twice"}, format="json").status_code == 200
    refund = office.post(f"/api/v1/sales/{kept['id']}/refund/", {
        "request_key": str(uuid.uuid4()), "reason": "Leaking bottle", "method": shop.momo.pk, "provider": shop.airtel.pk,
        "lines": [{"sale_item": kept["items"][0]["id"], "quantity": "1", "restock": False}]}, format="json")
    assert refund.status_code == 201, refund.data
    day = kept["business_date"]
    data = summary(office, day)
    m = data["metrics"]
    assert (m["gross_sales"], m["cancellations"], m["refunds"], m["net_sales"]) == (9000, 2000, 1000, 6000)
    assert (m["payments_collected"], m["refunds_issued"], m["net_collections"]) == (7000, 1000, 6000)
    assert m["reconciliation_difference"] == 0 and m["sale_count"] == 2
    momo = category(data, shop.momo)
    assert (line(momo, "M-PESA")["amount"], line(momo, "Airtel Money")["refunds"], momo["net"]) == (4000, 1000, 3000)
    assert category(data, shop.bank)["amount"] == 0  # the cancelled sale's payment is reversed, not collected
    reversed_list = transactions(office, day, status="REVERSED")
    assert reversed_list["count"] == 1 and reversed_list["results"][0]["status"] == "Reversed"
    refunds = transactions(office, day, kind="refund")
    assert refunds["count"] == 1 and refunds["results"][0]["provider"] == "Airtel Money"


# --- Daily closing ------------------------------------------------------------------------------------------

def test_closing_requires_the_payment_review_and_keeps_a_snapshot(owner, cashier, till, shop, make_product, set_today):
    product = make_product(price="1000", stock=50)
    sale = sell_raw(till, product, 5, [pay(shop.cash, 2000), pay(shop.momo, 3000, shop.mpesa)]).data
    shift = till.get("/api/v1/day/current/").data["shift"]
    figures = till.get("/api/v1/day/current/").data["shift_figures"]
    momo = next(p for p in figures["payments"] if p["method"] == shop.momo.pk)
    assert momo["providers"] == [{"provider": shop.mpesa.pk, "name": "M-PESA", "amount": "3000.00", "count": 1}]

    refused = close_shift(till, shift["id"], 2000, reviewed=False)
    assert refused.status_code == 400 and refused.data["code"] == "payments_not_reviewed"
    assert close_shift(till, shift["id"], 2000).status_code == 200
    total = ShiftPaymentTotal.objects.get(shift_id=shift["id"], payment_method=shop.momo)
    assert total.provider_breakdown == [{"provider": shop.mpesa.pk, "name": "M-PESA", "amount": "3000.00", "count": 1}]
    day = BusinessDay.objects.get(date=sale["business_date"])
    assert day.status == "CLOSED" and day.payment_snapshot["metrics"]["payments_collected"] == "5000.00"
    snapshot = day.payment_snapshot
    assert AuditLog.objects.get(action="shift.closed").after["payments_reviewed"] is True

    # A refund after closing goes on the next open day, linked to the sale; the closed day and its snapshot stay as they were.
    from datetime import date, timedelta

    set_today(date.fromisoformat(sale["business_date"]) + timedelta(days=1))
    start_shift(till)
    office = client_for(owner)
    refund = office.post(f"/api/v1/sales/{sale['id']}/refund/", {
        "request_key": str(uuid.uuid4()), "reason": "Customer returned it", "method": shop.momo.pk, "provider": shop.mpesa.pk,
        "lines": [{"sale_item": sale["items"][0]["id"], "quantity": "1", "restock": True}]}, format="json")
    assert refund.status_code == 201
    day.refresh_from_db()
    assert day.payment_snapshot == snapshot and day.net_sales == 5000
    assert summary(office, sale["business_date"])["metrics"]["refunds_issued"] == 0
    today = summary(office, refund.data["refunds"][0]["business_date"])["metrics"]
    assert (today["refunds_issued"], today["payments_collected"], today["net_collections"]) == (1000, 0, -1000)
    assert Payment.objects.get(sale_id=sale["id"], method=shop.momo).amount == 3000  # original allocation untouched


# --- Corrections and legacy payments ------------------------------------------------------------------------

def test_legacy_payment_without_provider_is_flagged_and_can_be_assigned_with_a_reason(accountant, cashier, till, shop, make_product):
    sale = sell_raw(till, make_product(price="6000", stock=5), 1, [pay(shop.momo, 6000, shop.mpesa)]).data
    legacy = Payment.objects.get(sale_id=sale["id"])
    Payment.objects.filter(pk=legacy.pk).update(provider=None, provider_name="")  # as recorded before providers existed
    office = client_for(accountant)
    data = summary(office, sale["business_date"])
    momo = category(data, shop.momo)
    assert line(momo, "Provider not recorded")["amount"] == 6000 and momo["unassigned"] == 1
    assert data["checks"]["providers_match_categories"] and data["unassigned_total"] == 1
    flagged = transactions(office, sale["business_date"], category=shop.momo.pk, provider="none")
    assert flagged["count"] == 1 and flagged["results"][0]["needs_provider"] is True

    url = f"/api/v1/payments/{legacy.pk}/provider/"
    assert client_for(cashier).post(url, {"provider": shop.airtel.pk, "reason": "Checked the Airtel statement"}, format="json").status_code == 403
    assert office.post(url, {"provider": shop.airtel.pk, "reason": "short"}, format="json").status_code == 400
    assert office.post(url, {"provider": shop.nmb.pk, "reason": "Checked the bank statement"}, format="json").data["code"] == "provider_mismatch"
    done = office.post(url, {"provider": shop.airtel.pk, "reason": "Checked the Airtel Money statement for 14:05"}, format="json")
    assert done.status_code == 200 and done.data["provider"] == "Airtel Money"
    legacy.refresh_from_db()
    assert (legacy.amount, legacy.method_id, legacy.provider_name) == (Decimal("6000"), shop.momo.pk, "Airtel Money")
    entry = AuditLog.objects.get(action="payment.corrected")
    assert entry.before["provider"] is None and entry.after["provider"] == "Airtel Money" and entry.reason


def test_recorded_provider_is_fixed_once_the_shift_is_closed(accountant, till, shop, make_product):
    sale = sell_raw(till, make_product(price="6000", stock=5), 1, [pay(shop.momo, 6000, shop.mpesa)]).data
    payment = Payment.objects.get(sale_id=sale["id"])
    office = client_for(accountant)
    url = f"/api/v1/payments/{payment.pk}/provider/"
    assert office.post(url, {"provider": shop.mixx.pk, "reason": "Cashier pressed the wrong button"}, format="json").status_code == 200
    close_shift(till, till.get("/api/v1/day/current/").data["shift"]["id"], 0)
    late = office.post(url, {"provider": shop.mpesa.pk, "reason": "Changed my mind about it"}, format="json")
    assert late.status_code == 409 and late.data["code"] == "shift_closed"


def test_deactivated_provider_stays_readable_on_old_sales_and_in_totals(owner, accountant, till, shop, make_product):
    sale = sell_raw(till, make_product(price="6000", stock=5), 1, [pay(shop.bank, 6000, shop.nbc)]).data
    boss = client_for(owner)
    assert boss.patch(f"/api/v1/payment-providers/{shop.nbc.pk}/", {"is_active": False, "name": "NBC Bank"}, format="json").status_code == 200
    again = client_for(accountant).get(f"/api/v1/sales/{sale['id']}/").data
    assert again["payments"][0]["provider_name"] == "NBC"  # the name as it was when the money was taken
    bank = category(summary(client_for(accountant), sale["business_date"]), shop.bank)
    nbc = line(bank, "NBC Bank")
    assert (nbc["amount"], nbc["is_active"]) == (6000, False)


# --- Reports ------------------------------------------------------------------------------------------------

def test_payment_reports_match_the_dashboard(owner, trading_day, shop):
    office = client_for(owner)
    data = summary(office, trading_day)
    daily = office.get(f"/api/v1/reports/payment-daily/?date_from={trading_day}&date_to={trading_day}").data
    assert Decimal(daily["totals"]["payments_collected"]) == data["metrics"]["payments_collected"]
    assert Decimal(daily["totals"][f"cat_{shop.momo.pk}"]) == category(data, shop.momo)["amount"]
    assert Decimal(daily["totals"]["difference"]) == 0
    providers = office.get(f"/api/v1/reports/payment-providers/?date_from={trading_day}&date_to={trading_day}").data
    assert Decimal(providers["totals"]["collected"]) == 10000
    assert {(r["category"], r["provider"]) for r in providers["rows"]} >= {("Cash", "—"), ("Mobile Money", "M-PESA"), ("Bank Transfer", "NBC")}
    for key in ("payment-weekly", "payment-monthly", "payment-cashiers"):
        report = office.get(f"/api/v1/reports/{key}/?date_from={trading_day}&date_to={trading_day}").data
        total_key = "payments_collected" if "payments_collected" in report["totals"] else "total"
        assert Decimal(report["totals"][total_key]) == 10000, key
    xlsx = office.get(f"/api/v1/reports/payment-providers/?date_from={trading_day}&date_to={trading_day}&download=xlsx")
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"
    sections = {r["key"]: r["section"] for r in office.get("/api/v1/reports/").data}
    assert sections["payment-daily"] == "Payment analysis" and sections["daily-sales"] != "Payment analysis"


# --- Data migration -----------------------------------------------------------------------------------------

def test_migration_adds_defaults_backfills_and_guesses_nothing(till, shop, make_product):
    sale = sell_raw(till, make_product(price="5000", stock=5), 1, [pay(shop.momo, 5000, shop.mpesa)]).data
    Payment.objects.filter(sale_id=sale["id"]).update(provider=None, provider_name="", recorded_by=None)
    PaymentProvider.objects.filter(name="Mixx by Yas").update(name="Mixx")  # the Owner renamed it: not added again
    totals_before = list(Payment.objects.values_list("method_id", "amount", "status"))

    migration = importlib.import_module("sales.migrations.0007_seed_payment_providers")
    migration.forward(live_apps, None)
    migration.forward(live_apps, None)  # running twice changes nothing more

    payment = Payment.objects.get(sale_id=sale["id"])
    assert payment.provider_id is None and payment.recorded_by.username == "cashier"
    assert payment.created_at == Sale.objects.get(pk=sale["id"]).created_at
    assert list(Payment.objects.values_list("method_id", "amount", "status")) == totals_before
    assert PaymentProvider.objects.filter(category=shop.momo).count() == 3  # the renamed provider is not added again
    assert PaymentMethod.objects.get(pk=shop.momo.pk).icon == "phone"
    log = AuditLog.objects.filter(action="payment_provider.migrated").first()
    assert log.after["payments_without_provider"] == 1
