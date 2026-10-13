from decimal import Decimal

from django.db import models
from django.db.models import Q


class SoldBy(models.TextChoices):
    """The approved selling units. To add one (for example "Single"), add it here and create a migration:
    the database itself refuses any value that is not on this list."""

    CRATE = "Crate", "Crate"
    CARTON = "Carton", "Carton"
    BOX = "Box", "Box"
    BOTTLE = "Bottle", "Bottle"
    PACK = "Pack", "Pack"


class Category(models.Model):
    name = models.CharField(max_length=80, unique=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


class Product(models.Model):
    """One sellable item. Stock is counted, priced and sold in its "Sold By" unit (the product's base unit)."""

    sku = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=150)
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.PROTECT, related_name="products")
    brand = models.CharField(max_length=80, blank=True)
    # Display text for the size. Kept in step with volume_ml when a volume is entered.
    package_size = models.CharField(max_length=40, blank=True, help_text="For example 750ml")
    pack_description = models.CharField(max_length=60, blank=True, help_text="How the supplier packs it, e.g. Box (24)")
    # "Sold By": the unit every quantity of this product is counted and sold in.
    base_unit = models.CharField(max_length=30, choices=SoldBy.choices, default=SoldBy.BOTTLE)
    # Volume of ONE individual bottle, in millilitres. Blank when not applicable or not yet verified.
    volume_ml = models.PositiveIntegerField(null=True, blank=True)
    # Package configuration: how many individual bottles are in one Sold By unit (for a crate, carton, box or pack).
    # S/No: the product's line number, as on the Excel sheet. Products that came from the workbook keep the
    # workbook's S/N; a product added later takes the next free number.
    serial_number = models.PositiveIntegerField(null=True, blank=True, unique=True)
    # Each product has its own figure; nothing assumes that every crate holds the same number.
    bottles_per_unit = models.PositiveIntegerField(null=True, blank=True)
    barcode = models.CharField(max_length=64, blank=True)
    selling_price = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    # The purchase price last entered or received, per Sold By unit.
    cost_price = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    # Weighted-average cost of the units now in stock, per Sold By unit. Maintained by the system as
    # stock is received; never typed in. Blank means no reliable cost is known.
    average_cost = models.DecimalField(max_digits=16, decimal_places=4, null=True, blank=True)
    # True when part of the average rests on an assumed cost (a delivery recorded without one).
    cost_provisional = models.BooleanField(default=False)
    reorder_point = models.DecimalField(max_digits=12, decimal_places=3, default=Decimal("0"))
    target_stock = models.DecimalField(max_digits=12, decimal_places=3, default=Decimal("0"))
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name", "package_size", "id"]
        constraints = [
            models.UniqueConstraint(fields=["barcode"], condition=~Q(barcode=""), name="product_barcode_unique_when_set"),
            models.CheckConstraint(condition=Q(selling_price__gte=0), name="product_price_not_negative"),
            models.CheckConstraint(condition=Q(cost_price__isnull=True) | Q(cost_price__gte=0), name="product_cost_not_negative"),
            models.CheckConstraint(condition=Q(reorder_point__gte=0) & Q(target_stock__gte=0), name="product_thresholds_not_negative"),
            models.CheckConstraint(condition=Q(base_unit__in=SoldBy.values), name="product_sold_by_is_approved_unit"),
            models.CheckConstraint(condition=Q(volume_ml__isnull=True) | Q(volume_ml__gt=0), name="product_volume_positive"),
            models.CheckConstraint(condition=Q(bottles_per_unit__isnull=True) | Q(bottles_per_unit__gt=0), name="product_bottles_per_unit_positive"),
            models.CheckConstraint(condition=Q(average_cost__isnull=True) | Q(average_cost__gte=0), name="product_average_cost_not_negative"),
        ]
        indexes = [models.Index(fields=["is_active", "name"])]

    def __str__(self):
        return f"{self.name} {self.package_size}".strip()

    def save(self, *args, **kwargs):
        if self.serial_number is None:
            self.serial_number = next_serial_number()
            if kwargs.get("update_fields") is not None:
                kwargs["update_fields"] = [*kwargs["update_fields"], "serial_number"]
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        # Products are switched off, never removed, so old sales keep their history (FR-PROD-06).
        raise models.ProtectedError("Products cannot be deleted. Deactivate the product instead.", {self})


class ProductUnit(models.Model):
    """An extra package a product can also be sold in, such as a crate of 12 bottles.

    `factor` is how many of the product's own Sold By units one of these contains. It can only be sold once
    the Owner has verified that figure (FR-PROD-04/05), and every sale line keeps the factor it was sold with,
    so changing the configuration later cannot alter past sales or stock.
    """

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="units")
    name = models.CharField(max_length=30, choices=SoldBy.choices)
    factor = models.DecimalField(max_digits=12, decimal_places=3, help_text="How many base units are in one of this unit")
    selling_price = models.DecimalField(max_digits=14, decimal_places=2)
    is_verified = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["product_id", "factor"]
        constraints = [
            models.UniqueConstraint(fields=["product", "name"], name="product_unit_name_unique"),
            models.CheckConstraint(condition=Q(factor__gt=0), name="product_unit_factor_positive"),
            models.CheckConstraint(condition=Q(selling_price__gte=0), name="product_unit_price_not_negative"),
            models.CheckConstraint(condition=Q(name__in=SoldBy.values), name="product_unit_is_approved_unit"),
        ]


def next_serial_number() -> int:
    """The next free S/No: after every product, and after every line of the imported workbook, so a number the
    workbook already uses for a product not yet added is never given to something else."""
    from django.db.models import Max

    from history.models import SourceProduct

    highest = [Product.objects.aggregate(m=Max("serial_number"))["m"], SourceProduct.objects.aggregate(m=Max("serial_number"))["m"]]
    return max((n for n in highest if n is not None), default=0) + 1
