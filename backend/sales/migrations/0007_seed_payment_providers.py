import re

from django.db import migrations
from django.db.models import Count, OuterRef, Q, Subquery, Sum
from django.utils.text import slugify

ICONS = {"cash": "cash", "mobile-money": "phone", "bank": "bank"}
DEFAULT_PROVIDERS = {"mobile-money": ["M-PESA", "Mixx by Yas", "Airtel Money"], "bank": ["NMB", "CRDB", "NBC"]}


def _totals(Payment):
    return {
        f"{r['method__code']}/{r['status']}": [r["n"], str(r["t"])]
        for r in Payment.objects.values("method__code", "status").annotate(n=Count("id"), t=Sum("amount")).order_by("method__code", "status")
    }


def forward(apps, schema_editor):
    """Default providers for the default categories, and when/by whom for every existing payment.

    Nothing about existing money changes: no amount, status, method or receipt is touched, and no
    provider is guessed for old Mobile Money or Bank payments. Those stay "provider not recorded"
    and are listed for the back office to review.
    """
    PaymentMethod = apps.get_model("sales", "PaymentMethod")
    Provider = apps.get_model("sales", "PaymentProvider")
    Payment = apps.get_model("sales", "Payment")
    Sale = apps.get_model("sales", "Sale")
    AuditLog = apps.get_model("core", "AuditLog")

    before = _totals(Payment)
    for method in PaymentMethod.objects.filter(code__in=ICONS):
        method.icon = ICONS[method.code]
        method.requires_provider = method.code in DEFAULT_PROVIDERS and not method.is_cash
        method.save(update_fields=["icon", "requires_provider", "updated_at"])

    seeded = []
    for category_code, names in DEFAULT_PROVIDERS.items():
        category = PaymentMethod.objects.filter(code=category_code).first()
        if category is None:
            continue
        for order, name in enumerate(names, start=1):
            key, slug = re.sub(r"[^a-z0-9]", "", name.lower()), slugify(name)[:30]
            # Already there (perhaps renamed since): never add it twice.
            if Provider.objects.filter(category=category).filter(Q(name_key=key) | Q(code=slug)).exists():
                continue
            Provider.objects.create(category=category, name_key=key, name=name, code=slug, sort_order=order)
            seeded.append(f"{category.name}: {name}")

    sales = Sale.objects.filter(pk=OuterRef("sale_id"))
    Payment.objects.update(created_at=Subquery(sales.values("created_at")[:1]), recorded_by=Subquery(sales.values("cashier")[:1]))

    after = _totals(Payment)
    if before != after:  # cannot happen: only dates and users were filled in. Stop rather than continue.
        raise RuntimeError(f"Payment totals changed during the migration: {before} -> {after}")
    unassigned = Payment.objects.filter(method__requires_provider=True, provider__isnull=True).count()
    AuditLog.objects.create(
        actor=None, actor_username="system", action="payment_provider.migrated", entity_type="PaymentProvider",
        summary=f"Payment providers introduced; {len(seeded)} default provider(s) added; "
                f"{unassigned} earlier payment(s) have no provider recorded and are flagged for review",
        after={"providers_added": seeded, "payment_totals_unchanged": after, "payments_without_provider": unassigned},
    )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0003_businesssettings_opening_balance_as_of_and_more"),
        ("sales", "0006_payment_providers"),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
