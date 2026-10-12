import re

from django.db import migrations, models

APPROVED = ["Crate", "Carton", "Box", "Bottle", "Pack"]
MILLILITRES = re.compile(r"^\s*(\d{1,5})\s*mls?\.?\s*$", re.IGNORECASE)


def carry_existing_data_forward(apps, schema_editor):
    """Bring existing products into the new shape without changing what anything means.

    - "Sold By": an existing unit is kept if it is one of the approved units (ignoring capitals and spaces).
      Anything else stops the migration with a list, so a person decides; nothing is remapped by guesswork.
    - Volume: taken from the size text only when that text is plainly a number of millilitres ("750 mls").
      Other sizes ("5lts", "Box (24)") are left for a person to enter.
    - Average cost: products already holding stock start from their entered purchase price, marked
      provisional because it does not come from recorded deliveries.
    """
    Product = apps.get_model("catalog", "Product")
    ProductUnit = apps.get_model("catalog", "ProductUnit")
    StockBalance = apps.get_model("inventory", "StockBalance")
    by_lower = {unit.lower(): unit for unit in APPROVED}

    problems = []
    for model, field, label in ((Product, "base_unit", "product"), (ProductUnit, "name", "extra unit")):
        for row in model.objects.all():
            current = getattr(row, field)
            approved = by_lower.get(" ".join(current.split()).lower())
            if approved is None:
                problems.append(f"{label} #{row.pk}: '{current}'")
            elif approved != current:
                setattr(row, field, approved)
                row.save(update_fields=[field])
    if problems:
        raise RuntimeError(
            "These selling units are not one of Crate, Carton, Box, Bottle, Pack and were NOT changed. "
            "Correct them (or approve a new unit) and run the migration again: " + "; ".join(problems)
        )

    in_stock = set(StockBalance.objects.filter(quantity__gt=0).values_list("product_id", flat=True))
    for product in Product.objects.all():
        changed = []
        match = MILLILITRES.match(product.package_size or "")
        if match and int(match.group(1)) > 0:
            product.volume_ml = int(match.group(1))
            changed.append("volume_ml")
        if product.pk in in_stock and product.cost_price is not None:
            product.average_cost = product.cost_price
            product.cost_provisional = True
            changed += ["average_cost", "cost_provisional"]
        if changed:
            product.save(update_fields=changed)


class Migration(migrations.Migration):

    dependencies = [
        ('catalog', '0001_initial'),
        ('inventory', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='product',
            name='average_cost',
            field=models.DecimalField(blank=True, decimal_places=4, max_digits=16, null=True),
        ),
        migrations.AddField(
            model_name='product',
            name='bottles_per_unit',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='product',
            name='cost_provisional',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='product',
            name='volume_ml',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        # Reversing leaves the data as it is: the new columns are simply dropped again.
        migrations.RunPython(carry_existing_data_forward, migrations.RunPython.noop),
    ]
