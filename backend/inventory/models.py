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
        DAMAGE_REVERSAL = "DAMAGE_REVERSAL", "Damage reversal"
        OTHER = "OTHER", "Other"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    business_date = models.DateField(db_index=True)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    reason = models.CharField(max_length=300)
    remarks = models.CharField(max_length=500, blank=True)
    evidence_reference = models.CharField(max_length=300, blank=True)
    request_key = models.UUIDField(unique=True, help_text="Sent by the screen so a retry cannot post twice")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    reversal_of = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT, related_name="reversal")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]


class StockAdjustmentLine(AppendOnlyModel):
    adjustment = models.ForeignKey(StockAdjustment, on_delete=models.PROTECT, related_name="lines")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    movement = models.OneToOneField("inventory.InventoryMovement", null=True, blank=True, on_delete=models.PROTECT, related_name="adjustment_line")
    quantity_before = models.DecimalField(max_digits=14, decimal_places=3)
    quantity_counted = models.DecimalField(max_digits=14, decimal_places=3)
    damaged_quantity = models.DecimalField(max_digits=14, decimal_places=3, null=True, blank=True)
    selling_price_at_damage = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    damage_value = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    average_cost_at_damage = models.DecimalField(max_digits=16, decimal_places=4, null=True, blank=True)
    inventory_cost_damage_value = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["adjustment", "product"], name="adjustment_line_once_per_product"),
            models.CheckConstraint(condition=Q(quantity_counted__gte=0), name="adjustment_count_not_negative"),
            models.CheckConstraint(condition=Q(damaged_quantity__isnull=True) | Q(damaged_quantity__gt=0), name="adjustment_damage_quantity_positive"),
            models.CheckConstraint(condition=Q(selling_price_at_damage__isnull=True) | Q(selling_price_at_damage__gte=0), name="adjustment_damage_price_not_negative"),
            models.CheckConstraint(condition=Q(damage_value__isnull=True) | Q(damage_value__gte=0), name="adjustment_damage_value_not_negative"),
            models.CheckConstraint(condition=Q(average_cost_at_damage__isnull=True) | Q(average_cost_at_damage__gte=0), name="adjustment_damage_cost_not_negative"),
            models.CheckConstraint(condition=Q(inventory_cost_damage_value__isnull=True) | Q(inventory_cost_damage_value__gte=0), name="adjustment_damage_cost_value_not_negative"),
        ]


class OpeningCount(models.Model):
    """A physical count sheet used to establish opening stock before go-live.

    Nothing reaches the live stock ledger until the Owner approves the sheet. Quantities always
    come from the physical count typed here, never from historical Excel figures.
    """

    class Status(models.TextChoices):
        PENDING_REVIEW = "PENDING_REVIEW", "Pending review"
        APPROVED = "APPROVED", "Approved"
        REJECTED = "REJECTED", "Rejected"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    count_date = models.DateField()
    counted_by_name = models.CharField(max_length=120, help_text="The person responsible for the physical count")
    note = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING_REVIEW)
    request_key = models.UUIDField(unique=True)
    prepared_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.UniqueConstraint(fields=["branch"], condition=Q(status="PENDING_REVIEW"), name="opening_count_one_pending"),
            models.CheckConstraint(
                condition=Q(status="PENDING_REVIEW", reviewed_by__isnull=True) | Q(status__in=["APPROVED", "REJECTED"], reviewed_by__isnull=False),
                name="opening_count_review_recorded",
            ),
        ]


class OpeningCountLine(models.Model):
    count = models.ForeignKey(OpeningCount, on_delete=models.PROTECT, related_name="lines")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    unit = models.CharField(max_length=30, help_text="The product's approved unit of measure when counted")
    counted_quantity = models.DecimalField(max_digits=14, decimal_places=3)
    # For comparison only (e.g. the last Excel closing figure). Never used to set stock.
    reference_quantity = models.DecimalField(max_digits=14, decimal_places=3, null=True, blank=True)
    reference_source = models.CharField(max_length=120, blank=True)
    # Filled in when the Owner approves the sheet.
    approved_quantity = models.DecimalField(max_digits=14, decimal_places=3, null=True, blank=True)
    movement = models.ForeignKey(InventoryMovement, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["product__name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["count", "product"], name="opening_count_line_once_per_product"),
            models.CheckConstraint(condition=Q(counted_quantity__gte=0), name="opening_count_not_negative"),
        ]

    @property
    def variance(self):
        return None if self.reference_quantity is None else self.counted_quantity - self.reference_quantity

class StockAlert(AppendOnlyModel):
    """A product's stock level got worse (for example healthy to low, or low to out of stock).

    Written by the stock movement that caused it, never by viewing a page, so each change is announced once.
    Getting better (a delivery) is not an alert.
    """

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="stock_alerts")
    movement = models.OneToOneField(InventoryMovement, on_delete=models.PROTECT, related_name="stock_alert")
    status_before = models.CharField(max_length=12)
    status_after = models.CharField(max_length=12)
    quantity = models.DecimalField(max_digits=14, decimal_places=3)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
