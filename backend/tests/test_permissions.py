"""Role rules are enforced by the server, including for direct API requests (AT-18, AT-UX-02/03)."""
import uuid

import pytest

from accounts.models import User
from core.models import AuditLog

from .conftest import PASSWORD, client_for, sell, start_shift

PROTECTED_GETS = [
    "/api/v1/auth/me/", "/api/v1/users/", "/api/v1/settings/", "/api/v1/setup/status/", "/api/v1/audit-log/",
    "/api/v1/products/", "/api/v1/categories/", "/api/v1/stock/movements/", "/api/v1/day/current/",
    "/api/v1/days/", "/api/v1/shifts/", "/api/v1/sales/", "/api/v1/payment-methods/", "/api/v1/schema/",
]


@pytest.mark.parametrize("url", PROTECTED_GETS)
def test_anonymous_is_rejected_everywhere(url):
    response = client_for().get(url)
    assert response.status_code in (401, 403)
    assert response.data["code"] in ("not_signed_in", "forbidden")


CASHIER_FORBIDDEN = [
    ("get", "/api/v1/users/", None),
    ("post", "/api/v1/users/", {"username": "x", "password": PASSWORD, "role": "OWNER"}),
    ("patch", "/api/v1/settings/", {"receipt_header": "hacked"}),
    ("get", "/api/v1/setup/status/", None),
    ("post", "/api/v1/setup/go-live/", {"opening_cumulative_sales": "0", "confirm": True}),
    ("get", "/api/v1/audit-log/", None),
    ("get", "/api/v1/stock/movements/", None),
    ("post", "/api/v1/stock/opening-counts/", {}),
    ("post", "/api/v1/stock/opening-counts/1/review/", {"approve": True}),
    ("get", "/api/v1/history/dashboard/", None),
    ("get", "/api/v1/history/records/", None),
    ("get", "/api/v1/history/review-items/", None),
    ("get", "/api/v1/history/source-products/", None),
    ("get", "/api/v1/history/unclassified-rows/", None),
    ("get", "/api/v1/history/exception-report/", None),
    ("post", "/api/v1/history/review-items/1/decide/", {}),
    ("post", "/api/v1/history/source-products/1/decide/", {}),
    ("post", "/api/v1/history/unclassified-rows/decide/", {}),
    ("post", "/api/v1/history/accept/", {}),
    ("post", "/api/v1/stock/adjustments/", {"request_key": str(uuid.uuid4()), "reason": "x", "lines": []}),
    ("post", "/api/v1/products/", {"name": "Free beer", "selling_price": "1"}),
    ("post", "/api/v1/categories/", {"name": "x"}),
    ("post", "/api/v1/payment-methods/", {"code": "x", "name": "x"}),
    ("get", "/api/v1/days/", None),
    ("get", "/api/v1/shifts/", None),
    ("post", "/api/v1/shifts/1/review/", {}),
    ("post", "/api/v1/sales/1/void/", {"reason": "because I can"}),
    ("get", "/api/v1/schema/", None),
    ("post", "/api/v1/sales/1/refund/", {}),
    ("get", "/api/v1/refunds/", None),
    ("post", "/api/v1/days/1/corrections/", {}),
    ("get", "/api/v1/suppliers/", None),
    ("post", "/api/v1/stock/receipts/", {}),
    ("get", "/api/v1/expenses/", None),
    ("get", "/api/v1/reports/", None),
    ("get", "/api/v1/reports/financial-summary/", None),
    ("put", "/api/v1/setup/opening-balance/", {}),
]


@pytest.mark.parametrize("method,url,body", CASHIER_FORBIDDEN)
def test_cashier_cannot_reach_back_office_endpoints(cashier, method, url, body):
    response = getattr(client_for(cashier), method)(url, body, format="json")
    assert response.status_code == 403, (url, response.data)
    assert response.data["message"] == "You do not have permission to do this."


def test_cashier_cannot_change_a_product_price(cashier, make_product):
    product = make_product(price="4500")
    response = client_for(cashier).patch(f"/api/v1/products/{product.pk}/", {"selling_price": "1"}, format="json")
    assert response.status_code == 403
    product.refresh_from_db()
    assert product.selling_price == 4500


def test_cashier_never_sees_purchase_cost(cashier, owner, make_product):
    make_product(stock=5)
    as_cashier = client_for(cashier).get("/api/v1/products/").data["results"][0]
    as_owner = client_for(owner).get("/api/v1/products/").data["results"][0]
    assert "cost_price" not in as_cashier and "reorder_point" not in as_cashier
    assert as_owner["cost_price"] == "1000.00"


def test_cashier_only_sees_own_sales(cashier, cashier2, shop, make_product):
    product = make_product(stock=10)
    mine, theirs = client_for(cashier), client_for(cashier2)
    start_shift(mine)
    start_shift(theirs)
    my_sale = sell(mine, [(product, 1)], [(shop.cash, 4500)]).data
    their_sale = sell(theirs, [(product, 2)], [(shop.cash, 9000)]).data
    listed = [s["id"] for s in mine.get("/api/v1/sales/").data["results"]]
    assert listed == [my_sale["id"]]
    assert mine.get(f"/api/v1/sales/{their_sale['id']}/").status_code == 404
    # asking for the other cashier explicitly changes nothing
    assert [s["id"] for s in mine.get(f"/api/v1/sales/?cashier={cashier2.pk}").data["results"]] == [my_sale["id"]]


def test_cashier_cannot_view_or_close_another_cashiers_shift(cashier, cashier2):
    other = start_shift(client_for(cashier2))
    mine = client_for(cashier)
    assert mine.get(f"/api/v1/shifts/{other['id']}/").status_code == 404
    assert mine.post(f"/api/v1/shifts/{other['id']}/close/", {"counted_cash": "0"}, format="json").status_code == 404


def test_accountant_has_finance_access_but_not_owner_only_controls(accountant, owner):
    client = client_for(accountant)
    for url in ("/api/v1/audit-log/", "/api/v1/stock/movements/", "/api/v1/days/", "/api/v1/shifts/"):
        assert client.get(url).status_code == 200, url
    assert client.get("/api/v1/users/").status_code == 403
    assert client.patch("/api/v1/settings/", {"receipt_header": "x"}, format="json").status_code == 403
    assert client.post(f"/api/v1/users/{owner.pk}/reset-password/", {"password": PASSWORD}, format="json").status_code == 403
    assert client.post("/api/v1/payment-methods/", {"code": "x", "name": "x"}, format="json").status_code == 403


def test_owner_manages_users_with_audit(owner):
    client = client_for(owner)
    created = client.post("/api/v1/users/", {"username": "asha", "full_name": "Asha", "role": "CASHIER", "password": PASSWORD}, format="json")
    assert created.status_code == 201 and "password" not in created.data
    user = User.objects.get(username="asha")
    assert user.must_change_password and user.check_password(PASSWORD)
    assert client.patch(f"/api/v1/users/{user.pk}/", {"is_active": False}, format="json").status_code == 200
    assert client.delete(f"/api/v1/users/{user.pk}/").status_code == 405  # accounts are deactivated, never deleted
    actions = set(AuditLog.objects.values_list("action", flat=True))
    assert {"user.created", "user.changed"} <= actions


def test_owner_cannot_lock_everyone_out(owner):
    client = client_for(owner)
    response = client.patch(f"/api/v1/users/{owner.pk}/", {"role": "CASHIER"}, format="json")
    assert response.status_code == 409 and response.data["code"] == "self_lockout"
    assert client.patch(f"/api/v1/users/{owner.pk}/", {"is_active": False}, format="json").status_code == 409


def test_weak_password_is_refused(owner):
    response = client_for(owner).post("/api/v1/users/", {"username": "b", "role": "CASHIER", "password": "12345"}, format="json")
    assert response.status_code == 400 and "password" in response.data["errors"]


def test_login_logout_and_plain_error_message(cashier):
    client = client_for()
    bad = client.post("/api/v1/auth/login/", {"username": "cashier", "password": "wrong"}, format="json")
    assert bad.status_code == 400
    assert bad.data["message"] == "The username or password is not correct. Please try again."
    unknown = client.post("/api/v1/auth/login/", {"username": "nobody", "password": "wrong"}, format="json")
    assert unknown.data == bad.data  # does not reveal which usernames exist
    good = client.post("/api/v1/auth/login/", {"username": "cashier", "password": PASSWORD}, format="json")
    assert good.status_code == 200 and good.data["role"] == "CASHIER" and "password" not in good.data
    assert client.get("/api/v1/auth/me/").status_code == 200
    assert client.post("/api/v1/auth/logout/").status_code == 204
    assert client.get("/api/v1/auth/me/").status_code in (401, 403)


def test_deactivated_user_cannot_sign_in(make_user):
    make_user("gone", User.Role.CASHIER, is_active=False)
    response = client_for().post("/api/v1/auth/login/", {"username": "gone", "password": PASSWORD}, format="json")
    assert response.status_code == 400


def test_login_is_rate_limited(cashier):
    client = client_for()
    codes = [client.post("/api/v1/auth/login/", {"username": "cashier", "password": "x"}, format="json").status_code for _ in range(12)]
    assert codes[-1] == 429


def test_login_requires_csrf_token(cashier):
    from rest_framework.test import APIClient

    client = APIClient(enforce_csrf_checks=True)
    assert client.post("/api/v1/auth/login/", {"username": "cashier", "password": PASSWORD}, format="json").status_code == 403
    token = client.get("/api/v1/auth/csrf/").data["csrfToken"]
    ok = client.post("/api/v1/auth/login/", {"username": "cashier", "password": PASSWORD}, format="json", HTTP_X_CSRFTOKEN=token)
    assert ok.status_code == 200


def test_user_can_change_own_password(cashier):
    client = client_for(cashier)
    wrong = client.post("/api/v1/auth/change-password/", {"current_password": "nope", "new_password": "Another-Good-77"}, format="json")
    assert wrong.status_code == 400
    assert client.post("/api/v1/auth/change-password/", {"current_password": PASSWORD, "new_password": "Another-Good-77"}, format="json").status_code == 200
    cashier.refresh_from_db()
    assert cashier.check_password("Another-Good-77")
    assert client.get("/api/v1/auth/me/").status_code == 200  # still signed in
