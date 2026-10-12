import uuid
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from catalog.models import Product
from core.models import Branch, BusinessSettings
from inventory.models import InventoryMovement
from inventory.services import post_movement
from sales.models import PaymentMethod

PASSWORD = "Correct-Horse-42"


@pytest.fixture(autouse=True)
def shop(db):
    """A live shop with the three default payment methods. Created here (not via migrations)
    so it also exists after transactional tests flush the database."""
    cache.clear()
    branch, _ = Branch.objects.get_or_create(code="MB", defaults={"name": "MERIBA Main Branch"})
    cfg, _ = BusinessSettings.objects.get_or_create(branch=branch)
    cfg.went_live_at = timezone.now()
    cfg.opening_stock_confirmed_at = timezone.now()
    cfg.save()
    cash, _ = PaymentMethod.objects.get_or_create(code="cash", defaults={"name": "Cash", "is_cash": True, "sort_order": 1})
    momo, _ = PaymentMethod.objects.get_or_create(code="mobile-money", defaults={"name": "Mobile Money", "sort_order": 2})
    bank, _ = PaymentMethod.objects.get_or_create(code="bank", defaults={"name": "Bank Transfer", "sort_order": 3})
    return SimpleNamespace(branch=branch, cfg=cfg, cash=cash, momo=momo, bank=bank)


@pytest.fixture
def make_user():
    def _make(username, role, **extra):
        user = User(username=username, role=role, full_name=username.title(), **extra)
        user.set_password(PASSWORD)
        user.save()
        return user
    return _make


@pytest.fixture
def owner(make_user):
    return make_user("owner", User.Role.OWNER)


@pytest.fixture
def accountant(make_user):
    return make_user("accountant", User.Role.ACCOUNTANT)


@pytest.fixture
def cashier(make_user):
    return make_user("cashier", User.Role.CASHIER)


@pytest.fixture
def cashier2(make_user):
    return make_user("cashier2", User.Role.CASHIER)


def client_for(user=None) -> APIClient:
    client = APIClient()
    if user is not None:
        client.force_login(user)
    return client


@pytest.fixture
def api():
    return client_for


@pytest.fixture
def make_product(shop, owner):
    counter = {"n": 0}

    def _make(name="Konyagi", price="4500", stock=0, **extra):
        counter["n"] += 1
        # Test products start with a known purchase price of 1,000, which is also their average cost.
        extra.setdefault("cost_price", Decimal("1000"))
        extra.setdefault("average_cost", extra["cost_price"])
        product = Product.objects.create(sku=f"T{counter['n']:04d}", name=name, selling_price=Decimal(price), **extra)
        if stock:
            with transaction.atomic():
                post_movement(
                    branch=shop.branch, product=product, delta=Decimal(stock), movement_type=InventoryMovement.Type.OPENING,
                    source_type="Test", source_id=product.pk, user=owner, business_date=date(2026, 1, 1),
                )
        return product
    return _make


@pytest.fixture
def set_today(monkeypatch):
    """Pretend the shop's local date is something else (used to walk through several business days)."""
    def _set(value: date):
        monkeypatch.setattr("trading.services.local_today", lambda: value)
        monkeypatch.setattr("trading.views.local_today", lambda: value)
        monkeypatch.setattr("inventory.services.local_today", lambda: value)
        monkeypatch.setattr("catalog.table.local_today", lambda: value)
    return _set


def stock_of(product) -> Decimal:
    from inventory.models import StockBalance

    row = StockBalance.objects.filter(product=product).first()
    return row.quantity if row else Decimal("0")


def sale_payload(items, payments, key=None) -> dict:
    return {
        "request_key": str(key or uuid.uuid4()),
        "items": [{"product": p.pk, "quantity": str(q)} for p, q in items],
        "payments": [{"method": m.pk, "amount": str(a)} for m, a in payments],
    }


def start_shift(client, opening_float="0"):
    response = client.post("/api/v1/day/start/", {"opening_float": opening_float}, format="json")
    assert response.status_code in (200, 201), response.data
    return response.data


def sell(client, items, payments, key=None):
    return client.post("/api/v1/sales/", sale_payload(items, payments, key), format="json")
