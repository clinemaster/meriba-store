from zoneinfo import ZoneInfo

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models import F


def backfill_damage_records(apps, schema_editor):
    Adjustment = apps.get_model("inventory", "StockAdjustment")
    Line = apps.get_model("inventory", "StockAdjustmentLine")
    Movement = apps.get_model("inventory", "InventoryMovement")
    for adjustment in Adjustment.objects.filter(business_date__isnull=True).iterator():
        movement_date = Movement.objects.filter(
            source_type="StockAdjustment", source_id=str(adjustment.pk), branch_id=adjustment.branch_id,
        ).order_by("id").values_list("business_date", flat=True).first()
        if movement_date is None:
            movement_date = adjustment.created_at.astimezone(ZoneInfo(settings.BUSINESS_TIMEZONE)).date()
        Adjustment.objects.filter(pk=adjustment.pk).update(business_date=movement_date)

    for line in Line.objects.filter(movement__isnull=True).iterator():
        movement_id = Movement.objects.filter(
            source_type="StockAdjustment", source_id=str(line.adjustment_id), product_id=line.product_id,
        ).order_by("id").values_list("id", flat=True).first()
        if movement_id is not None:
            Line.objects.filter(pk=line.pk).update(movement_id=movement_id)

    Line.objects.filter(adjustment__kind="DAMAGE", damaged_quantity__isnull=True) \
        .filter(quantity_before__gt=F("quantity_counted")) \
        .update(damaged_quantity=F("quantity_before") - F("quantity_counted"))


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0003_stock_alert"),
    ]

    operations = [
        migrations.AddField(
            model_name="stockadjustment",
            name="business_date",
            field=models.DateField(blank=True, db_index=True, null=True),
        ),
        migrations.AddField(
            model_name="stockadjustment",
            name="remarks",
            field=models.CharField(blank=True, max_length=500),
        ),
        migrations.AddField(
            model_name="stockadjustment",
            name="evidence_reference",
            field=models.CharField(blank=True, max_length=300),
        ),
        migrations.AddField(
            model_name="stockadjustment",
            name="reversal_of",
            field=models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT,
                                       related_name="reversal", to="inventory.stockadjustment"),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="damaged_quantity",
            field=models.DecimalField(blank=True, decimal_places=3, max_digits=14, null=True),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="movement",
            field=models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT,
                                       related_name="adjustment_line", to="inventory.inventorymovement"),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="selling_price_at_damage",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=14, null=True),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="damage_value",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=16, null=True),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="average_cost_at_damage",
            field=models.DecimalField(blank=True, decimal_places=4, max_digits=16, null=True),
        ),
        migrations.AddField(
            model_name="stockadjustmentline",
            name="inventory_cost_damage_value",
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=16, null=True),
        ),
        migrations.RunPython(backfill_damage_records, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="stockadjustment",
            name="business_date",
            field=models.DateField(db_index=True),
        ),
        migrations.AlterField(
            model_name="stockadjustment",
            name="kind",
            field=models.CharField(max_length=20, choices=[("OPENING", "Opening stock count"), ("COUNT", "Stock count correction"), ("DAMAGE", "Damaged or expired"), ("DAMAGE_REVERSAL", "Damage reversal"), ("OTHER", "Other")]),
        ),
        migrations.AddConstraint(
            model_name="stockadjustmentline",
            constraint=models.CheckConstraint(condition=models.Q(("damaged_quantity__isnull", True), ("damaged_quantity__gt", 0), _connector="OR"), name="adjustment_damage_quantity_positive"),
        ),
        migrations.AddConstraint(
            model_name="stockadjustmentline",
            constraint=models.CheckConstraint(condition=models.Q(("selling_price_at_damage__isnull", True), ("selling_price_at_damage__gte", 0), _connector="OR"), name="adjustment_damage_price_not_negative"),
        ),
        migrations.AddConstraint(
            model_name="stockadjustmentline",
            constraint=models.CheckConstraint(condition=models.Q(("damage_value__isnull", True), ("damage_value__gte", 0), _connector="OR"), name="adjustment_damage_value_not_negative"),
        ),
        migrations.AddConstraint(
            model_name="stockadjustmentline",
            constraint=models.CheckConstraint(condition=models.Q(("average_cost_at_damage__isnull", True), ("average_cost_at_damage__gte", 0), _connector="OR"), name="adjustment_damage_cost_not_negative"),
        ),
        migrations.AddConstraint(
            model_name="stockadjustmentline",
            constraint=models.CheckConstraint(condition=models.Q(("inventory_cost_damage_value__isnull", True), ("inventory_cost_damage_value__gte", 0), _connector="OR"), name="adjustment_damage_cost_value_not_negative"),
        ),
    ]