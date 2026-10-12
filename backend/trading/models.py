from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import F, Q

ZERO = Decimal("0")


class BusinessDay(models.Model):
    """One trading day and its cumulative monetary sales balance.

    closing_cumulative_sales = opening_cumulative_sales + net_sales.
    This is a running total of sales value. It is NOT cash on hand, profit, or stock.
    """

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        CLOSED = "CLOSED", "Closed"

    branch = models.ForeignKey("core.Branch", on_delete=models.PROTECT, related_name="business_days")
    date = models.DateField()
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.OPEN)
    # The finalised day this one carried its opening balance from. One-to-one, so a
    # closing balance can never be carried forward twice.
    previous_day = models.OneToOneField("self", null=True, blank=True, on_delete=models.PROTECT, related_name="next_day")
    opening_cumulative_sales = models.DecimalField(max_digits=16, decimal_places=2)
    gross_sales = models.DecimalField(max_digits=16, decimal_places=2, default=ZERO)
    discounts = models.DecimalField(max_digits=16, decimal_places=2, default=ZERO)
    voids = models.DecimalField(max_digits=16, decimal_places=2, default=ZERO)
    refunds = models.DecimalField(max_digits=16, decimal_places=2, default=ZERO)
    net_sales = models.DecimalField(max_digits=16, decimal_places=2, default=ZERO)
    closing_cumulative_sales = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    last_receipt_seq = models.PositiveIntegerField(default=0)
    opened_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    opened_at = models.DateTimeField(auto_now_add=True)
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-date"]
        constraints = [
            models.UniqueConstraint(fields=["branch", "date"], name="business_day_one_per_date"),
            models.UniqueConstraint(fields=["branch"], condition=Q(status="OPEN"), name="business_day_one_open_per_branch"),
            models.CheckConstraint(
                condition=Q(net_sales=F("gross_sales") - F("discounts") - F("voids") - F("refunds")),
                name="business_day_net_sales_formula",
            ),
            models.CheckConstraint(
                condition=(Q(status="OPEN") & Q(closing_cumulative_sales__isnull=True))
                | (Q(status="CLOSED") & Q(closing_cumulative_sales=F("opening_cumulative_sales") + F("net_sales"))),
                name="business_day_closing_balance_formula",
            ),
        ]

    def __str__(self):
        return f"{self.date:%d %b %Y}"


class CashierShift(models.Model):
    """A cashier's accountable period inside a business day, with its own cash count."""

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        PENDING = "PENDING", "Waiting for payment checks"
        BALANCED = "BALANCED", "Balanced"
        DISCREPANCY = "DISCREPANCY", "Cash difference to review"
        APPROVED = "APPROVED", "Reviewed and approved"

    business_day = models.ForeignKey(BusinessDay, on_delete=models.PROTECT, related_name="shifts")
    cashier = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="shifts")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    opening_float = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    opened_at = models.DateTimeField(auto_now_add=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    # Figures frozen at closing time.
    sales_total = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    expected_cash = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    counted_cash = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    cash_variance = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    closing_note = models.CharField(max_length=500, blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_note = models.CharField(max_length=500, blank=True)

    class Meta:
        ordering = ["-opened_at"]
        constraints = [
            models.UniqueConstraint(fields=["business_day", "cashier"], name="shift_one_per_cashier_per_day"),
            models.UniqueConstraint(fields=["cashier"], condition=Q(status="OPEN"), name="shift_one_open_per_cashier"),
            models.CheckConstraint(condition=Q(opening_float__gte=0), name="shift_float_not_negative"),
            models.CheckConstraint(condition=Q(counted_cash__isnull=True) | Q(counted_cash__gte=0), name="shift_count_not_negative"),
            models.CheckConstraint(
                condition=Q(cash_variance__isnull=True) | Q(cash_variance=F("counted_cash") - F("expected_cash")),
                name="shift_variance_formula",
            ),
        ]


class ShiftPaymentTotal(models.Model):
    """Per payment method: what the system recorded for the shift, frozen at closing.

    Non-cash methods stay unverified until an Accountant/Owner checks them against
    the phone or bank statement (a typed reference is not proof of settlement).
    """

    shift = models.ForeignKey(CashierShift, on_delete=models.PROTECT, related_name="payment_totals")
    payment_method = models.ForeignKey("sales.PaymentMethod", on_delete=models.PROTECT, related_name="+")
    recorded_amount = models.DecimalField(max_digits=16, decimal_places=2)
    transaction_count = models.PositiveIntegerField(default=0)
    is_verified = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["shift", "payment_method"], name="shift_payment_total_once")]
