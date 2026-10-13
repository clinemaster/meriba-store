from django.db import migrations, models


def number_existing_products(apps, schema_editor):
    """Products that came from the workbook take the workbook's S/N; the others follow on, in the order they were added."""
    Product = apps.get_model("catalog", "Product")
    SourceProduct = apps.get_model("history", "SourceProduct")
    taken = set()
    for product in Product.objects.order_by("id"):
        serials = sorted(s for s in SourceProduct.objects.filter(product_id=product.pk).values_list("serial_number", flat=True) if s is not None)
        serial = next((s for s in serials if s not in taken), None)
        if serial is not None:
            product.serial_number = serial
            product.save(update_fields=["serial_number"])
            taken.add(serial)
    following = max([*taken, *(s for s in SourceProduct.objects.values_list("serial_number", flat=True) if s is not None)], default=0)
    for product in Product.objects.filter(serial_number__isnull=True).order_by("id"):
        following += 1
        product.serial_number = following
        product.save(update_fields=["serial_number"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0003_approved_units_enforced"),
        ("history", "0003_profit_cell_correction"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="serial_number",
            field=models.PositiveIntegerField(blank=True, null=True, unique=True),
        ),
        migrations.RunPython(number_existing_products, migrations.RunPython.noop),
    ]
