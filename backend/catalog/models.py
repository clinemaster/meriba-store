from decimal import Decimal

from django.db import models
from django.db.models import Q


class Category(models.Model):
    name = models.CharField(max_length=80, unique=True)

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


class Product(models.Model):
    """One sellable item, counted and priced in a single base unit (e.g. Bottle, Crate, Carton)."""

    sku = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=150)
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.PROTECT, related_name="products")
    brand = models.CharField(max_length=80, blank=True)
    package_size = models.CharField(max_length=40, blank=True, help_text="For example 750ml")
    pack_description = models.CharField(max_length=60, blank=True, help_text="How the supplier packs it, e.g. Box (24)")
    base_unit = models.CharField(max_length=30, default="Bottle", help_text="The unit that is counted and sold")
    barcode = models.CharField(max_length=64, blank=True)
    selling_price = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    cost_price = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
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
        ]
        indexes = [models.Index(fields=["is_active", "name"])]

    def __str__(self):
        return f"{self.name} {self.package_size}".strip()

    def delete(self, *args, **kwargs):
        # Products are switched off, never removed, so old sales keep their history (FR-PROD-06).
        raise models.ProtectedError("Products cannot be deleted. Deactivate the product instead.", {self})


class ProductUnit(models.Model):
    """An extra selling unit for a product, such as a carton of 12 bottles.

    It can only be sold once the Owner has verified the conversion factor (FR-PROD-04/05).
    """

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="units")
    name = models.CharField(max_length=30)
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
        ]
