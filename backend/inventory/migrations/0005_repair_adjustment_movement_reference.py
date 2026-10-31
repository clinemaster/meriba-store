from django.db import migrations


def ensure_and_backfill_movement_reference(apps, schema_editor):
    Line = apps.get_model("inventory", "StockAdjustmentLine")
    Movement = apps.get_model("inventory", "InventoryMovement")
    table = Line._meta.db_table
    columns = {column.name for column in schema_editor.connection.introspection.get_table_description(
        schema_editor.connection.cursor(), table,
    )}
    if "movement_id" not in columns:
        schema_editor.add_field(Line, Line._meta.get_field("movement"))

    for line in Line.objects.filter(movement__isnull=True).iterator():
        movement_id = Movement.objects.filter(
            source_type="StockAdjustment", source_id=str(line.adjustment_id), product_id=line.product_id,
        ).order_by("id").values_list("id", flat=True).first()
        if movement_id is not None:
            Line.objects.filter(pk=line.pk).update(movement_id=movement_id)


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0004_damage_register"),
    ]

    operations = [
        migrations.RunPython(ensure_and_backfill_movement_reference, migrations.RunPython.noop),
    ]