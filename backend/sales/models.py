import re

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.utils import timezone

from core.models import AppendOnlyModel, ImmutableError


class PaymentMethod(models.Model):
    """A payment category (Cash, Mobile Money, Bank, ...), configured by the Owner without code changes.

    `code` is the stable identifier; the name, icon, order and on/off state can change at any time.
    A category used by any payment or refund is never deleted, only switched off.
    """

    ICONS = ["cash", "phone", "bank", "card", "wallet", "other"]

    code = models.SlugField(max_length=20, unique=True)
    name = models.CharField(max_length=40)
    description = models.CharField(max_length=200, blank=True)
    icon = models.CharField(max_length=12, default="other", choices=[(i, i) for i in ICONS])
    # Only cash methods count toward the cash drawer.
    is_cash = models.BooleanField(default=False)
    # When set, every payment in this category must name one of its active providers (M-PESA, NMB, ...).
    requires_provider = models.BooleanField(default=False)
    reference_label = models.CharField(max_length=40, blank=True, help_text="e.g. 'M-Pesa transaction ID'")
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "id"]
        constraints = [
            models.CheckConstraint(condition=~(Q(is_cash=True) & Q(requires_provider=True)), name="cash_category_has_no_provider"),
        ]

    def __str__(self):
        return self.name

    def in_use(self) -> bool:
        from finance.models import Expense
        from trading.models import ShiftPaymentTotal

        return (Payment.objects.filter(method=self).exists() or Refund.objects.filter(method=self).exists()
                or Expense.objects.filter(method=self).exists() or ShiftPaymentTotal.objects.filter(payment_method=self).exists()
                or self.providers.exists())


class PaymentProvider(models.Model):
    """Who carried a non-cash payment: M-PESA, Mixx by Yas, Airtel Money, NMB, CRDB, NBC, ... Belongs to one category.

    Payments keep a copy of the provider's name, so renaming or switching off a provider never changes an old receipt.
    """

    category = models.ForeignKey(PaymentMethod, on_delete=models.PROTECT, related_name="providers")
    code = models.SlugField(max_length=30)
    name = models.CharField(max_length=60)
    # Lower-case letters and digits only ("M-Pesa" and "MPESA" are the same provider); unique within the category.
    name_key = models.CharField(max_length=60, editable=False)
    description = models.CharField(max_length=200, blank=True)
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["category__sort_order", "sort_order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["category", "code"], name="provider_code_unique_in_category"),
            models.UniqueConstraint(fields=["category", "name_key"], name="provider_name_unique_in_category"),
            models.CheckConstraint(condition=~Q(name_key=""), name="provider_name_not_blank"),
        ]

    def __str__(self):
        return self.name

    @staticmethod
    def key_for(name: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (name or "").lower())[:60]

    def save(self, *args, **kwargs):
        self.name = " ".join((self.name or "").split())
        self.name_key = self.key_for(self.name)
        if kwargs.get("update_fields") and "name" in kwargs["update_fields"]:
            kwargs["update_fields"] = {*kwargs["update_fields"], "name_key"}
        super().save(*args, **kwargs)

    def in_use(self) -> bool:
        return Payment.objects.filter(provider=self).exists() or Refund.objects.filter(provider=self).exists()


class Sale(models.Model):
    """A completed sale. Never edited or deleted; cancelling it is a recorded void."""

    class Status(models.TextChoices):
        COMPLETED = "COMPLETED", "Completed"
        VOIDED = "VOIDED", "Cancelled"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="+")
    business_day = models.ForeignKey("trading.BusinessDay", on_delete=models.PROTECT, related_name="sales")
    shift = models.ForeignKey("trading.CashierShift", on_delete=models.PROTECT, related_name="sales")
    cashier = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="sales")
    receipt_number = models.CharField(max_length=30, unique=True)
    # Sent by the screen with every new sale; the same key can never create two sales.
    request_key = models.UUIDField(unique=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.COMPLETED)
    subtotal = models.DecimalField(max_digits=16, decimal_places=2)
    discount_total = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=16, decimal_places=2)
    amount_tendered = models.DecimalField(max_digits=16, decimal_places=2)
    change_due = models.DecimalField(max_digits=16, decimal_places=2, default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    voided_at = models.DateTimeField(null=True, blank=True)
    voided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    void_reason = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.CheckConstraint(condition=Q(total=F("subtotal") - F("discount_total")), name="sale_total_formula"),
            models.CheckConstraint(condition=Q(total__gt=0) & Q(discount_total__gte=0), name="sale_amounts_valid"),
            models.CheckConstraint(condition=Q(change_due=F("amount_tendered") - F("total")) & Q(change_due__gte=0), name="sale_change_formula"),
            models.CheckConstraint(
                condition=Q(status="COMPLETED", voided_at__isnull=True) | (Q(status="VOIDED", voided_at__isnull=False) & ~Q(void_reason="")),
                name="sale_void_needs_reason",
            ),
        ]
        indexes = [models.Index(fields=["business_day", "cashier"])]

    def delete(self, *args, **kwargs):
        raise ImmutableError("Completed sales cannot be deleted. Cancel the sale with a reason instead.")


class SaleItem(AppendOnlyModel):
    sale = models.ForeignKey(Sale, on_delete=models.PROTECT, related_name="items")
    product = models.ForeignKey("catalog.Product", on_delete=models.PROTECT, related_name="+")
    # Snapshots: later product edits must not change what an old receipt says.
    product_name = models.CharField(max_length=200)
    unit_name = models.CharField(max_length=30)
    unit_factor = models.DecimalField(max_digits=12, decimal_places=3, default=1)
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    quantity_base = models.DecimalField(max_digits=14, decimal_places=3)
    unit_price = models.DecimalField(max_digits=14, decimal_places=2)
    line_total = models.DecimalField(max_digits=16, decimal_places=2)
    # Cost of goods sold, frozen at the moment of sale from the product's weighted-average cost.
    # Blank when no reliable cost was known: profit for the line is then "not available", never guessed.
    unit_cost = models.DecimalField(max_digits=16, decimal_places=4, null=True, blank=True)
    cost_total = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    cost_provisional = models.BooleanField(default=False)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gt=0) & Q(unit_price__gt=0), name="sale_item_positive"),
            models.CheckConstraint(condition=Q(quantity_base=F("quantity") * F("unit_factor")), name="sale_item_base_quantity_formula"),
        ]


class Refund(models.Model):
    """Money given back for a completed sale. Recorded on the business day it happens,
    linked to the original sale; the original (possibly closed) day is never changed."""

    sale = models.ForeignKey(Sale, on_delete=models.PROTECT, related_name="refunds")
    business_day = models.ForeignKey("trading.BusinessDay", on_delete=models.PROTECT, related_name="refund_records")
    # Set when cash left a cashier's drawer; it lowers that shift's expected cash.
    shift = models.ForeignKey("trading.CashierShift", null=True, blank=True, on_delete=models.PROTECT, related_name="refund_records")
    method = models.ForeignKey(PaymentMethod, on_delete=models.PROTECT, related_name="+")
    provider = models.ForeignKey(PaymentProvider, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    provider_name = models.CharField(max_length=60, blank=True)
    total = models.DecimalField(max_digits=16, decimal_places=2)
    reason = models.CharField(max_length=300)
    reference = models.CharField(max_length=60, blank=True)
    request_key = models.UUIDField(unique=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
        constraints = [
            models.CheckConstraint(condition=Q(total__gt=0), name="refund_total_positive"),
            models.CheckConstraint(condition=~Q(reason=""), name="refund_needs_reason"),
        ]

    def delete(self, *args, **kwargs):
        raise ImmutableError("Refunds cannot be deleted.")


class RefundItem(AppendOnlyModel):
    refund = models.ForeignKey(Refund, on_delete=models.PROTECT, related_name="items")
    sale_item = models.ForeignKey(SaleItem, on_delete=models.PROTECT, related_name="refund_items")
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    quantity_base = models.DecimalField(max_digits=14, decimal_places=3)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    # False = damaged / not fit for sale: money is refunded but stock is not increased.
    restocked = models.BooleanField(default=True)
    # Cost of the goods put back on the shelf (zero for damaged items, which stay a cost; blank if the cost was unknown).
    cost_returned = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["refund", "sale_item"], name="refund_item_once_per_line"),
            models.CheckConstraint(condition=Q(quantity__gt=0) & Q(amount__gt=0), name="refund_item_positive"),
        ]


class Payment(models.Model):
    """How part of a sale was actually paid. `amount` is what was kept (cash handed over minus change)."""

    class Status(models.TextChoices):
        RECORDED = "RECORDED", "Recorded"
        VERIFIED = "VERIFIED", "Verified"
        REVERSED = "REVERSED", "Reversed"

    sale = models.ForeignKey(Sale, on_delete=models.PROTECT, related_name="payments")
    method = models.ForeignKey(PaymentMethod, on_delete=models.PROTECT, related_name="+")
    # Blank on payments recorded before providers existed: shown as "provider not recorded", never guessed.
    provider = models.ForeignKey(PaymentProvider, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    # The provider's name when the payment was taken, kept for the receipt and the audit trail.
    provider_name = models.CharField(max_length=60, blank=True)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    tendered = models.DecimalField(max_digits=16, decimal_places=2)
    reference = models.CharField(max_length=60, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.RECORDED)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    # When the money was taken. With no credit sales, that is the moment of the sale.
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0) & Q(tendered__gte=F("amount")), name="payment_amounts_valid"),
        ]
        indexes = [models.Index(fields=["method", "provider"], name="payment_method_provider_idx")]

    def delete(self, *args, **kwargs):
        raise ImmutableError("Payments cannot be deleted.")
