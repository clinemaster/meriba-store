from django.conf import settings
from django.db import models
from django.db.models import Q

from core.models import AppendOnlyModel, ImmutableError


class Supplier(models.Model):
    name = models.CharField(max_length=120, unique=True)
    phone = models.CharField(max_length=40, blank=True)
    notes = models.CharField(max_length=300, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class GoodsReceipt(models.Model):
    """Stock that physically arrived and was counted in. Saving it increases stock; it cannot be edited."""

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    supplier = models.ForeignKey(Supplier, null=True, blank=True, on_delete=models.PROTECT, related_name="receipts")
    # Supplier's invoice / delivery note number, only if there is one. Never invented.
    reference = models.CharField(max_length=60, blank=True)
    business_date = models.DateField(db_index=True)
    note = models.CharField(max_length=300, blank=True)
    total_cost = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    request_key = models.UUIDField(unique=True)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]

    def delete(self, *args, **kwargs):
        raise ImmutableError("Stock receipts cannot be deleted. Record a stock adjustment instead.")


class GoodsReceiptLine(AppendOnlyModel):
    receipt = models.ForeignKey(GoodsReceipt, on_delete=models.PROTECT, related_name="lines")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    quantity = models.DecimalField(max_digits=14, decimal_places=3)
    unit_cost = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    line_cost = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["receipt", "product"], name="receipt_line_once_per_product"),
            models.CheckConstraint(condition=Q(quantity__gt=0), name="receipt_line_quantity_positive"),
            models.CheckConstraint(condition=Q(unit_cost__isnull=True) | Q(unit_cost__gte=0), name="receipt_line_cost_not_negative"),
        ]


class Expense(models.Model):
    """Money spent running the shop. Never part of the cumulative sales balance.

    When it was paid in cash from a cashier's drawer, `shift` is set and that shift's expected cash goes down.
    """

    class Status(models.TextChoices):
        RECORDED = "RECORDED", "Recorded"
        VOIDED = "VOIDED", "Cancelled"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    business_date = models.DateField(db_index=True)
    category = models.CharField(max_length=60)
    description = models.CharField(max_length=300)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    method = models.ForeignKey("sales.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    shift = models.ForeignKey("trading.CashierShift", null=True, blank=True, on_delete=models.PROTECT, related_name="expenses")
    reference = models.CharField(max_length=60, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.RECORDED)
    void_reason = models.CharField(max_length=300, blank=True)
    voided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    request_key = models.UUIDField(unique=True)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-business_date", "-id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="expense_amount_positive"),
            models.CheckConstraint(condition=Q(status="RECORDED") | ~Q(void_reason=""), name="expense_void_needs_reason"),
        ]

    def delete(self, *args, **kwargs):
        raise ImmutableError("Expenses cannot be deleted. Cancel the expense with a reason instead.")
