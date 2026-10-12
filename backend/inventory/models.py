from django.conf import settings
from django.db import models
from django.db.models import Q

from core.models import AppendOnlyModel


class StockBalance(models.Model):
    """Current physical quantity of one product in one branch. Only inventory.services may change it."""

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="stock_balances")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="stock_balances")
    quantity = models.DecimalField(max_digits=14, decimal_places=3, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["branch", "product"], name="stock_balance_one_per_product_branch"),
            # Last line of defence against overselling: the database itself refuses negative stock.
            models.CheckConstraint(condition=Q(quantity__gte=0), name="stock_balance_not_negative"),
        ]


class InventoryMovement(AppendOnlyModel):
    """The stock ledger: every increase or decrease, traced to its source. Append-only."""

    class Type(models.TextChoices):
        OPENING = "OPENING", "Opening stock"
        RECEIPT = "RECEIPT", "Stock received"
        SALE = "SALE", "Sale"
        VOID = "VOID", "Sale cancelled"
        RETURN = "RETURN", "Customer return"
        ADJUSTMENT = "ADJUSTMENT", "Stock adjustment"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="movements")
    movement_type = models.CharField(max_length=12, choices=Type.choices)
    quantity_delta = models.DecimalField(max_digits=14, decimal_places=3)
    balance_before = models.DecimalField(max_digits=14, decimal_places=3)
    balance_after = models.DecimalField(max_digits=14, decimal_places=3)
    business_date = models.DateField(db_index=True)
    source_type = models.CharField(max_length=40)
    source_id = models.CharField(max_length=60)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    reason = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            # A source event can move a product once only, even if the request is retried (FR-STK-15).
            models.UniqueConstraint(
                fields=["movement_type", "source_type", "source_id", "product"], name="movement_once_per_source"
            ),
            models.CheckConstraint(condition=~Q(quantity_delta=0), name="movement_not_zero"),
            models.CheckConstraint(
                condition=Q(balance_after=models.F("balance_before") + models.F("quantity_delta")),
                name="movement_balances_add_up",
            ),
        ]
        indexes = [models.Index(fields=["product", "business_date"])]


class StockAdjustment(models.Model):
    """A recorded count: opening stock at go-live, or a later correction with a reason."""

    class Kind(models.TextChoices):
        OPENING = "OPENING", "Opening stock count"
        COUNT = "COUNT", "Stock count correction"
        DAMAGE = "DAMAGE", "Damaged or expired"
        OTHER = "OTHER", "Other"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    reason = models.CharField(max_length=300)
    request_key = models.UUIDField(unique=True, help_text="Sent by the screen so a retry cannot post twice")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]


class StockAdjustmentLine(AppendOnlyModel):
    adjustment = models.ForeignKey(StockAdjustment, on_delete=models.PROTECT, related_name="lines")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    quantity_before = models.DecimalField(max_digits=14, decimal_places=3)
    quantity_counted = models.DecimalField(max_digits=14, decimal_places=3)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["adjustment", "product"], name="adjustment_line_once_per_product"),
            models.CheckConstraint(condition=Q(quantity_counted__gte=0), name="adjustment_count_not_negative"),
        ]
