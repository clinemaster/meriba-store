"""Real simultaneous requests against PostgreSQL (AT-07, AT-08)."""
import threading
import uuid

import pytest
from django.db import connection

from accounts.models import User
from inventory.models import InventoryMovement
from sales.models import Sale

from .conftest import client_for, sale_payload, start_shift, stock_of

pytestmark = pytest.mark.django_db(transaction=True)


def run_together(jobs):
    barrier, results = threading.Barrier(len(jobs)), [None] * len(jobs)

    def worker(index, job):
        try:
            barrier.wait(timeout=10)
            results[index] = job()
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i, job)) for i, job in enumerate(jobs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    return results


def test_at08_two_cashiers_cannot_oversell(make_user, shop, make_product):
    product = make_product(stock=4)
    clients = [client_for(make_user(f"till{i}", User.Role.CASHIER)) for i in range(2)]
    for client in clients:
        start_shift(client)
    jobs = [lambda c=c: c.post("/api/v1/sales/", sale_payload([(product, 3)], [(shop.cash, 13500)]), format="json") for c in clients]
    codes = sorted(r.status_code for r in run_together(jobs))
    assert codes == [201, 409]
    assert stock_of(product) == 1 and Sale.objects.count() == 1
    assert len(set(Sale.objects.values_list("receipt_number", flat=True))) == 1


def test_at07_same_request_sent_twice_at_once_saves_one_sale(make_user, shop, make_product):
    product = make_product(stock=10)
    client = client_for(make_user("till", User.Role.CASHIER))
    start_shift(client)
    payload = sale_payload([(product, 2)], [(shop.cash, 9000)], uuid.uuid4())
    user = User.objects.get(username="till")
    jobs = [lambda: client_for(user).post("/api/v1/sales/", payload, format="json") for _ in range(4)]
    results = run_together(jobs)
    assert sorted(r.status_code for r in results) == [200, 200, 200, 201]
    assert len({r.data["id"] for r in results}) == 1
    assert Sale.objects.count() == 1 and stock_of(product) == 8
    assert InventoryMovement.objects.filter(movement_type="SALE").count() == 1


def test_many_sales_at_once_get_unique_receipts_and_exact_stock(make_user, shop, make_product):
    product = make_product(stock=100)
    clients = [client_for(make_user(f"till{i}", User.Role.CASHIER)) for i in range(4)]
    for client in clients:
        start_shift(client)
    jobs = [lambda c=c: c.post("/api/v1/sales/", sale_payload([(product, 1)], [(shop.cash, 4500)]), format="json")
            for c in clients for _ in range(3)]
    assert [r.status_code for r in run_together(jobs)] == [201] * 12
    assert stock_of(product) == 88
    assert len(set(Sale.objects.values_list("receipt_number", flat=True))) == 12


def test_sale_and_closing_at_the_same_moment_stay_consistent(make_user, shop, make_product):
    """Either the sale is inside the closed shift's totals, or it is refused. Never lost in between."""
    from trading.models import BusinessDay, CashierShift

    product = make_product(price="1000", stock=10)
    user = make_user("till", User.Role.CASHIER)
    shift = start_shift(client_for(user))
    jobs = [
        lambda: client_for(user).post("/api/v1/sales/", sale_payload([(product, 1)], [(shop.cash, 1000)]), format="json"),
        lambda: client_for(user).post(f"/api/v1/shifts/{shift['id']}/close/", {"counted_cash": "1000", "note": "count"}, format="json"),
    ]
    sale, _closing = run_together(jobs)
    sold = 1000 if sale.status_code == 201 else 0
    assert sale.status_code in (201, 409)
    assert CashierShift.objects.get().sales_total == sold
    assert BusinessDay.objects.get().closing_cumulative_sales == sold
