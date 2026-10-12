from django.db import migrations


def seed(apps, schema_editor):
    """FR-PAY-01: cash, mobile money and bank transfer. The Owner can add more or switch any off."""
    PaymentMethod = apps.get_model("sales", "PaymentMethod")
    if PaymentMethod.objects.exists():
        return
    PaymentMethod.objects.create(code="cash", name="Cash", is_cash=True, sort_order=1)
    PaymentMethod.objects.create(code="mobile-money", name="Mobile Money", reference_label="Transaction ID", sort_order=2)
    PaymentMethod.objects.create(code="bank", name="Bank Transfer", reference_label="Bank reference", sort_order=3)


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0002_initial'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
