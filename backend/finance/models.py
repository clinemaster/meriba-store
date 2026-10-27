import uuid

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
    # The product's weighted-average cost just before and just after this delivery: the purchase-cost history.
    average_cost_before = models.DecimalField(max_digits=16, decimal_places=4, null=True, blank=True)
    average_cost_after = models.DecimalField(max_digits=16, decimal_places=4, null=True, blank=True)

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


class ReceiptImport(models.Model):
    """One upload of the "Upload Received Stock" workbook: what the file said, and what was done with it.

    Nothing changes stock until the batch is confirmed. Confirming posts ordinary stock receipts through
    receive_stock(), so the costing, ledger and audit rules are the same as for a delivery typed by hand.
    The file's fingerprint is kept so the same file cannot add stock a second time by accident.
    """

    class Status(models.TextChoices):
        PREVIEW = "PREVIEW", "Previewed, not imported"
        CONFIRMED = "CONFIRMED", "Imported"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)  # the import batch number
    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    file_name = models.CharField(max_length=200)
    file_hash = models.CharField(max_length=64, db_index=True)
    rows = models.JSONField(help_text="The rows exactly as read from the file")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PREVIEW)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    confirmed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    confirmed_at = models.DateTimeField(null=True, blank=True)
    receipts = models.ManyToManyField(GoodsReceipt, blank=True, related_name="imports")
    result = models.JSONField(null=True, blank=True, help_text="The summary shown when it was imported")
    reimport_reason = models.CharField(max_length=300, blank=True)
    # The Owner's review, kept until confirmed: corrections by Excel row number, and combine/separate per product.
    edits = models.JSONField(default=dict, blank=True)
    decisions = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(status="PREVIEW", confirmed_by__isnull=True) | Q(status="CONFIRMED", confirmed_by__isnull=False),
                name="receipt_import_confirmation_recorded"),
        ]
