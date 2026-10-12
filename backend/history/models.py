"""Historical Excel records. Everything here is reference material kept apart from the live system:
no table in this module is ever read to create sales, payments, stock movements or balances."""
from django.conf import settings
from django.db import models
from django.db.models import Q

from core.models import AppendOnlyModel


class ReviewStatus(models.TextChoices):
    PENDING_REVIEW = "PENDING_REVIEW", "Pending review"
    APPROVED = "APPROVED", "Approved"
    REJECTED = "REJECTED", "Rejected"
    IMPORTED = "IMPORTED", "Imported"


class ImportBatch(models.Model):
    """One committed import of one workbook file."""

    filename = models.CharField(max_length=255)
    file_sha256 = models.CharField(max_length=64, db_index=True)
    is_supplementary = models.BooleanField(default=False)
    summary = models.JSONField(default=dict)
    imported_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]


class SourceProduct(models.Model):
    """Product Mapping Review: one line per product name as it appears in the source sheets.

    Similar names are never merged automatically. The Owner decides what each one is.
    """

    source_key = models.CharField(max_length=220, unique=True)  # "<S/N>|<normalised name>"
    serial_number = models.IntegerField(null=True, blank=True, db_index=True)
    source_name = models.CharField(max_length=200)
    normalised_name = models.CharField(max_length=200, db_index=True)
    pack_text = models.CharField(max_length=80, blank=True)
    description_text = models.CharField(max_length=80, blank=True)
    first_seen = models.DateField(null=True)
    last_seen = models.DateField(null=True)
    record_count = models.PositiveIntegerField(default=0)
    # Price history exactly as recorded, one list per price type: [{"amount", "from", "to"}]
    selling_prices = models.JSONField(default=list)
    purchase_prices = models.JSONField(default=list)
    flags = models.JSONField(default=list)
    proposed_name = models.CharField(max_length=200, blank=True)
    proposed_unit = models.CharField(max_length=30, blank=True)
    proposed_package_size = models.CharField(max_length=40, blank=True)

    review_status = models.CharField(max_length=16, choices=ReviewStatus.choices[:3], default=ReviewStatus.PENDING_REVIEW)
    confirmed_name = models.CharField(max_length=200, blank=True)
    confirmed_unit = models.CharField(max_length=30, blank=True)
    confirmed_package_size = models.CharField(max_length=40, blank=True)
    product = models.ForeignKey("catalog.Product", null=True, blank=True, on_delete=models.PROTECT, related_name="source_products")
    decision_note = models.CharField(max_length=500, blank=True)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["serial_number", "first_seen", "id"]

    def __str__(self):
        return self.source_name


class HistoricalRecord(models.Model):
    """Historical Daily Records: one product line from one daily sheet, exactly as it was written.

    A dated snapshot, not a transaction. It never changes live stock.
    """

    class Validation(models.TextChoices):
        VALID = "VALID", "Valid"
        WARNING = "WARNING", "Warning"
        ERROR = "ERROR", "Error"

    batch = models.ForeignKey(ImportBatch, on_delete=models.PROTECT, related_name="records")
    source_key = models.CharField(max_length=240, unique=True)  # "<date>|<S/N>|<normalised name>"
    source_file = models.CharField(max_length=255)
    worksheet = models.CharField(max_length=60)
    source_row = models.PositiveIntegerField()
    business_date = models.DateField(db_index=True)
    source_product = models.ForeignKey(SourceProduct, on_delete=models.PROTECT, related_name="records")
    original = models.JSONField()  # heading -> the cell text as it was

    opening_qty = models.DecimalField(max_digits=16, decimal_places=3, null=True)
    purchases_qty = models.DecimalField(max_digits=16, decimal_places=3, null=True)
    total_stock = models.DecimalField(max_digits=16, decimal_places=3, null=True)
    sold_qty = models.DecimalField(max_digits=16, decimal_places=3, null=True)
    closing_qty = models.DecimalField(max_digits=16, decimal_places=3, null=True)
    # Two different price types, exactly as the workbook labels them. Never mixed.
    purchase_price = models.DecimalField(max_digits=16, decimal_places=2, null=True)
    sales_price = models.DecimalField(max_digits=16, decimal_places=2, null=True)
    total_sales = models.DecimalField(max_digits=18, decimal_places=2, null=True)
    profit = models.DecimalField(max_digits=18, decimal_places=2, null=True)
    stock_value = models.DecimalField(max_digits=18, decimal_places=2, null=True)
    total_purchases = models.DecimalField(max_digits=18, decimal_places=2, null=True)

    validation_status = models.CharField(max_length=8, choices=Validation.choices, default=Validation.VALID)
    validation_messages = models.JSONField(default=list)
    import_status = models.CharField(max_length=16, choices=ReviewStatus.choices, default=ReviewStatus.IMPORTED)
    # True while an exception touching this record is unresolved, or was accepted without being explained.
    incomplete = models.BooleanField(default=False)

    class Meta:
        ordering = ["business_date", "source_row"]
        indexes = [models.Index(fields=["source_product", "business_date"])]


class UnclassifiedRow(models.Model):
    """A row under the product list whose meaning is not established (e.g. unlabelled totals).

    Kept exactly as written. It can be labelled, excluded or flagged, but it is never a transaction.
    """

    class Status(models.TextChoices):
        PENDING_REVIEW = "PENDING_REVIEW", "Pending review"
        APPROVED = "APPROVED", "Classified"
        REJECTED = "REJECTED", "Excluded"
        FLAGGED = "FLAGGED", "Needs investigation"

    batch = models.ForeignKey(ImportBatch, on_delete=models.PROTECT, related_name="unclassified_rows")
    source_key = models.CharField(max_length=120, unique=True)  # "<date>|row <n>"
    source_file = models.CharField(max_length=255)
    worksheet = models.CharField(max_length=60)
    source_row = models.PositiveIntegerField(db_index=True)
    business_date = models.DateField(db_index=True)
    original = models.JSONField()  # [{"column": "J", "value": "1322700"}]
    proposed_classification = models.CharField(max_length=80, blank=True)
    proposal_basis = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING_REVIEW)
    classification = models.CharField(max_length=80, blank=True)
    reason = models.CharField(max_length=500, blank=True)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["business_date", "source_row"]
        constraints = [
            models.CheckConstraint(condition=~Q(status="REJECTED") | ~Q(reason=""), name="unclassified_exclusion_needs_reason"),
        ]


class ReviewItem(models.Model):
    """An exception found in the historical data that a person must decide on."""

    class Kind(models.TextChoices):
        MISSING_DATES = "MISSING_DATES", "Missing dates"
        CARRY_FORWARD_BREAK = "CARRY_FORWARD_BREAK", "Stock does not carry forward"
        SAME_NAME_DIFFERENT_PRICE = "SAME_NAME_DIFFERENT_PRICE", "Same name, different prices"
        PRICE_ANOMALY = "PRICE_ANOMALY", "Unusual price change"
        MISSING_PRICE = "MISSING_PRICE", "Missing price"
        ARITHMETIC = "ARITHMETIC", "Figures do not add up"
        INVALID_VALUES = "INVALID_VALUES", "Unreadable values"
        DUPLICATE_CONFLICT = "DUPLICATE_CONFLICT", "Same record with different values"
        UNREADABLE_SHEET = "UNREADABLE_SHEET", "Sheet not read"

    class Severity(models.TextChoices):
        MATERIAL = "MATERIAL", "Material"
        INFO = "INFO", "For information"

    key = models.CharField(max_length=200, unique=True)
    kind = models.CharField(max_length=30, choices=Kind.choices, db_index=True)
    severity = models.CharField(max_length=10, choices=Severity.choices, default=Severity.MATERIAL)
    title = models.CharField(max_length=255)
    details = models.JSONField(default=dict)
    source_products = models.ManyToManyField(SourceProduct, related_name="review_items", blank=True)
    records = models.ManyToManyField(HistoricalRecord, related_name="review_items", blank=True)
    date_from = models.DateField(null=True, blank=True)
    date_to = models.DateField(null=True, blank=True)
    batch = models.ForeignKey(ImportBatch, on_delete=models.PROTECT, related_name="review_items")
    created_at = models.DateTimeField(auto_now_add=True)

    status = models.CharField(max_length=16, choices=ReviewStatus.choices[:3], default=ReviewStatus.PENDING_REVIEW, db_index=True)
    resolution = models.CharField(max_length=40, blank=True)
    decision = models.JSONField(default=dict, blank=True)
    note = models.CharField(max_length=1000, blank=True)
    evidence_reference = models.CharField(max_length=300, blank=True)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["status", "severity", "kind", "date_from", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(status="PENDING_REVIEW") | (~Q(note="") & ~Q(resolution="")), name="review_decision_needs_note"
            ),
        ]


class ReviewNote(AppendOnlyModel):
    """A verified explanation or pointer to supplementary evidence, added by a reviewer. Never edited."""

    item = models.ForeignKey(ReviewItem, on_delete=models.PROTECT, related_name="notes")
    text = models.CharField(max_length=1000)
    evidence_reference = models.CharField(max_length=300, blank=True)
    source_reference = models.CharField(max_length=300, blank=True)
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]


class ApprovedPrice(AppendOnlyModel):
    """An Owner-confirmed price for a source product: which price type, how much, and from when.

    The original workbook values stay untouched in HistoricalRecord; this is the approved interpretation.
    """

    class PriceType(models.TextChoices):
        SELLING = "SELLING", "Selling price"
        PURCHASE_COST = "PURCHASE_COST", "Purchase cost"
        OTHER = "OTHER", "Other"

    source_product = models.ForeignKey(SourceProduct, on_delete=models.PROTECT, related_name="approved_prices")
    price_type = models.CharField(max_length=14, choices=PriceType.choices)
    amount = models.DecimalField(max_digits=16, decimal_places=2)
    effective_date = models.DateField()
    review_item = models.ForeignKey(ReviewItem, null=True, blank=True, on_delete=models.PROTECT, related_name="approved_prices")
    note = models.CharField(max_length=500, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    approved_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["source_product_id", "price_type", "effective_date", "id"]
        constraints = [models.CheckConstraint(condition=Q(amount__gte=0), name="approved_price_not_negative")]


class HistoryAcceptance(AppendOnlyModel):
    """The Owner's explicit statement that the historical data is accepted as reconciled.

    Only possible when nothing is pending. It stops counting the moment a new exception appears.
    """

    note = models.CharField(max_length=500)
    snapshot = models.JSONField(default=dict)
    accepted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    accepted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]
