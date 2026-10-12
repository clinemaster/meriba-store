from decimal import Decimal

from django.conf import settings
from django.db import models


class ImmutableError(Exception):
    """Raised when code tries to change or delete a record that must be preserved."""


class AppendOnlyModel(models.Model):
    """Rows can be created but never edited or deleted through the ORM."""

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ImmutableError(f"{self.__class__.__name__} records cannot be changed.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ImmutableError(f"{self.__class__.__name__} records cannot be deleted.")


class Branch(models.Model):
    name = models.CharField(max_length=120)
    code = models.CharField(max_length=12, unique=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.name


class BusinessSettings(models.Model):
    """Per-branch configuration. Live selling stays blocked until `went_live_at` is set."""

    branch = models.OneToOneField(Branch, on_delete=models.PROTECT, related_name="settings")
    currency_code = models.CharField(max_length=3, default="TZS")
    receipt_header = models.CharField(max_length=200, blank=True, default="MERIBA STORE")
    receipt_footer = models.CharField(max_length=200, blank=True, default="Thank you. Karibu tena!")
    split_payments_enabled = models.BooleanField(default=True)
    # Cash differences up to this amount (either way) are treated as balanced.
    cash_variance_tolerance = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    # Cumulative monetary sales balance the first business day starts from (SRS: zero unless approved).
    opening_cumulative_sales = models.DecimalField(max_digits=16, decimal_places=2, default=Decimal("0"))
    # Before go-live the Owner or Accountant may prepare a figure; only the Owner's go-live approves it.
    prepared_opening_cumulative_sales = models.DecimalField(max_digits=16, decimal_places=2, null=True, blank=True)
    opening_balance_as_of = models.DateField(null=True, blank=True, help_text="Cutover date the opening balance is correct for")
    opening_balance_note = models.CharField(max_length=300, blank=True)
    opening_balance_prepared_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    opening_stock_confirmed_at = models.DateTimeField(null=True, blank=True)
    opening_stock_confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    went_live_at = models.DateTimeField(null=True, blank=True)
    went_live_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )

    class Meta:
        verbose_name_plural = "business settings"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(cash_variance_tolerance__gte=0), name="settings_tolerance_not_negative"
            ),
            models.CheckConstraint(
                condition=models.Q(opening_cumulative_sales__gte=0), name="settings_opening_sales_not_negative"
            ),
        ]

    @property
    def is_live(self) -> bool:
        return self.went_live_at is not None


class AuditLog(AppendOnlyModel):
    """Who did what, when, to which record, and why. Append-only."""

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+")
    actor_username = models.CharField(max_length=150, blank=True)
    action = models.CharField(max_length=60, db_index=True)
    entity_type = models.CharField(max_length=60, blank=True)
    entity_id = models.CharField(max_length=60, blank=True)
    summary = models.CharField(max_length=255, blank=True)
    reason = models.CharField(max_length=500, blank=True)
    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    request_id = models.CharField(max_length=40, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["entity_type", "entity_id"])]
