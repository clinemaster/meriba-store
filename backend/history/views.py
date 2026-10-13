import csv
from decimal import Decimal
from io import BytesIO

from django.db.models import Q
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwner, IsOwnerOrAccountant
from catalog.models import Product
from core.errors import BusinessRuleError
from core.services import audit, local_today

from . import services
from .models import ApprovedPrice, HistoricalRecord, ImportBatch, ReviewItem, SourceProduct, UnclassifiedRow
from .parser import file_digest, parse_workbook

MAX_UPLOAD = 15 * 1024 * 1024


def _plan_from_upload(request):
    upload = request.FILES.get("file")
    if upload is None:
        raise BusinessRuleError("Choose the Excel workbook to read.", code="no_file", status_code=400)
    if not upload.name.lower().endswith(".xlsx"):
        raise BusinessRuleError("The file must be an Excel workbook ending in .xlsx.", code="bad_file", status_code=400)
    if upload.size > MAX_UPLOAD:
        raise BusinessRuleError("The file is too large (the limit is 15 MB).", code="too_large", status_code=400)
    data = upload.read()
    try:
        parsed = parse_workbook(BytesIO(data), upload.name)
    except Exception:
        raise BusinessRuleError(
            "This file could not be opened as an Excel workbook. Check that it is not damaged or password-protected.",
            code="unreadable", status_code=400)
    return services.build_plan(parsed, file_digest(data))


class DryRunView(APIView):
    """Reads a workbook and reports exactly what importing it would do. Saves nothing."""

    permission_classes = [IsOwnerOrAccountant]
    parser_classes = [MultiPartParser]

    @extend_schema(request=None, responses={200: dict})
    def post(self, request):
        plan = _plan_from_upload(request)
        if request.query_params.get("download") == "csv":
            return _preview_report(plan, request.user)
        return Response(services.describe_plan(plan))


def _preview_report(plan, user):
    """The exception report for a file that has NOT been imported, so it can be read before anything is committed."""
    from .analysis import plain

    summary = plan["summary"]
    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="meriba_import_preview_{local_today()}.csv"'
    response.write("\ufeff")
    writer = csv.writer(response)
    writer.writerow(["MERIBA historical import PREVIEW - nothing has been saved", str(local_today())])
    writer.writerow(["Status", "NOT IMPORTED and NOT RECONCILED. These figures are as written in the file and have not been reviewed."])
    writer.writerow(["File", summary["file"]])
    writer.writerow(["Sheets read", f"{summary['worksheets_read']} of {summary['worksheets']}", "Dates", f"{summary['date_from']} to {summary['date_to']}"])
    writer.writerow(["Lines", summary["product_rows"], "New", summary["accepted_new"], "Already stored", summary["duplicates_skipped"],
                     "Conflicting (would not be imported)", summary["conflicts_not_imported"]])
    writer.writerow(["Unlabelled rows", summary["unlabelled_rows"], "Source products", summary["source_products"],
                     "Total sales as written (unverified)", summary["workbook_total_sales"]])
    writer.writerow([])
    writer.writerow(["Section", "Type", "Severity", "New?", "What was found", "Lines affected", "Source details"])
    for issue in plan["issues"]:
        writer.writerow(["Exception", ReviewItem.Kind(issue["kind"]).label, "Material" if issue["severity"] == "MATERIAL" else "For information",
                         "New" if issue["is_new"] else "Already listed", issue["title"], len(issue["record_keys"]), _flatten(plain(issue["details"]))])
    for row in plan["rows"]:
        if row["validation_status"] != "VALID":
            writer.writerow(["Line problem", row["validation_status"].title(), "", "", row["name"], 1,
                             f"{row['worksheet']} row {row['row']}: {' '.join(row['validation_messages'])}"])
    by_row = {}
    for other in plan["others"]:
        by_row.setdefault(other["row"], []).append(other)
    for number in sorted(by_row):
        rows = by_row[number]
        writer.writerow(["Unlabelled row", "Pending review", "", "", f"Row {number} in {len(rows)} sheet(s)", len(rows),
                         "Proposed: " + " / ".join(sorted({r["proposal"] for r in rows})) + ". Never imported as a transaction."])
    audit(user, "report.exported", summary=f"Exported the import preview report for '{summary['file']}'"[:255])
    return response


class BatchSerializer(serializers.ModelSerializer):
    imported_by_name = serializers.CharField(source="imported_by.display_name", read_only=True)

    class Meta:
        model = ImportBatch
        fields = ["id", "filename", "is_supplementary", "created_at", "imported_by_name", "summary"]


class ImportView(generics.ListAPIView):
    """List of imports; POST commits one (Owner only, after confirming a dry run and a backup)."""

    serializer_class = BatchSerializer
    queryset = ImportBatch.objects.select_related("imported_by")
    parser_classes = [MultiPartParser]
    pagination_class = None

    def get_permissions(self):
        return [IsOwner()] if self.request.method == "POST" else [IsOwnerOrAccountant()]

    @extend_schema(request=None, responses={201: dict})
    def post(self, request):
        truthy = ("true", "1", "yes", "on")
        if str(request.data.get("backup_confirmed", "")).lower() not in truthy:
            raise BusinessRuleError("Take a backup of the database first and tick the box to confirm it.",
                                    code="backup_required", status_code=400)
        if str(request.data.get("confirm", "")).lower() not in truthy:
            raise BusinessRuleError("Tick the box to confirm you have read the preview.", code="not_confirmed", status_code=400)
        plan = _plan_from_upload(request)
        if not plan["new"] and not plan["new_others"] and not any(i["is_new"] for i in plan["issues"]):
            # Nothing new: say so plainly rather than creating an empty import (a safe repeat).
            return Response({"nothing_new": True, "preview": services.describe_plan(plan)})
        batch = services.commit_plan(plan, request.user)
        return Response({"nothing_new": False, "batch": BatchSerializer(batch).data, "dashboard": services.dashboard()}, status=201)


class DashboardView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        return Response(services.dashboard())


class AcceptView(APIView):
    permission_classes = [IsOwner]

    @extend_schema(request=None, responses={200: dict})
    def post(self, request):
        services.accept_history(owner=request.user, note=request.data.get("note", ""))
        return Response(services.dashboard())


# --- Exceptions ----------------------------------------------------------------------------

class ReviewItemSerializer(serializers.ModelSerializer):
    kind_label = serializers.CharField(source="get_kind_display", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    decided_by_name = serializers.CharField(source="decided_by.display_name", read_only=True, default="")
    resolution_label = serializers.SerializerMethodField()
    allowed_resolutions = serializers.SerializerMethodField()
    owner_only = serializers.SerializerMethodField()
    source_products = serializers.SerializerMethodField()
    notes = serializers.SerializerMethodField()
    records_affected = serializers.SerializerMethodField()

    class Meta:
        model = ReviewItem
        fields = ["id", "kind", "kind_label", "severity", "title", "details", "date_from", "date_to", "status", "status_label",
                  "resolution", "resolution_label", "decision", "note", "evidence_reference", "decided_by_name", "decided_at",
                  "allowed_resolutions", "owner_only", "source_products", "notes", "records_affected", "created_at"]

    def get_resolution_label(self, obj) -> str:
        return services.RESOLUTION_LABELS.get(obj.resolution, "")

    def get_allowed_resolutions(self, obj) -> list:
        return [{"code": code, "label": services.RESOLUTION_LABELS[code]}
                for code in services.RESOLUTIONS.get(obj.kind, services.GENERAL)]

    def get_owner_only(self, obj) -> bool:
        return obj.kind in services.OWNER_ONLY_KINDS

    def get_source_products(self, obj) -> list:
        return [{"id": p.pk, "source_name": p.source_name, "serial_number": p.serial_number, "selling_prices": p.selling_prices,
                 "purchase_prices": p.purchase_prices, "confirmed_name": p.confirmed_name} for p in obj.source_products.all()]

    def get_notes(self, obj) -> list:
        return [{"id": n.pk, "text": n.text, "evidence_reference": n.evidence_reference, "source_reference": n.source_reference,
                 "author": n.author.display_name, "created_at": n.created_at} for n in obj.notes.all()]

    def get_records_affected(self, obj) -> int:
        return obj.records.count()


def _items():
    return ReviewItem.objects.select_related("decided_by").prefetch_related("source_products", "notes__author")


class ReviewItemListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = ReviewItemSerializer

    def get_queryset(self):
        qs = _items()
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        if params.get("kind"):
            qs = qs.filter(kind=params["kind"])
        if params.get("severity"):
            qs = qs.filter(severity=params["severity"])
        return qs


class PriceInput(serializers.Serializer):
    source_product = serializers.PrimaryKeyRelatedField(queryset=SourceProduct.objects.all())
    price_type = serializers.ChoiceField(choices=ApprovedPrice.PriceType.choices)
    amount = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=0)
    effective_date = serializers.DateField()
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


class IdentityInput(serializers.Serializer):
    source_product = serializers.PrimaryKeyRelatedField(queryset=SourceProduct.objects.all())
    confirmed_name = serializers.CharField(max_length=200)
    confirmed_package_size = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    confirmed_unit = serializers.CharField(max_length=30, required=False, allow_blank=True, default="")


class DecideItemSerializer(serializers.Serializer):
    resolution = serializers.CharField(max_length=40)
    note = serializers.CharField(max_length=1000)
    evidence_reference = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    approved_prices = PriceInput(many=True, required=False, default=list)
    identities = IdentityInput(many=True, required=False, default=list)


class ReviewItemDecideView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=DecideItemSerializer, responses=ReviewItemSerializer)
    def post(self, request, pk):
        ser = DecideItemSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.decide_item(user=request.user, item_id=pk, **ser.validated_data)
        return Response(ReviewItemSerializer(_items().get(pk=pk)).data)


class NoteSerializer(serializers.Serializer):
    text = serializers.CharField(max_length=1000)
    evidence_reference = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    source_reference = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class ReviewItemNoteView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=NoteSerializer, responses=ReviewItemSerializer)
    def post(self, request, pk):
        ser = NoteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        services.add_note(user=request.user, item_id=pk, **ser.validated_data)
        return Response(ReviewItemSerializer(_items().get(pk=pk)).data)


class ReviewItemReopenView(APIView):
    permission_classes = [IsOwner]

    @extend_schema(request=None, responses=ReviewItemSerializer)
    def post(self, request, pk):
        services.reopen_item(owner=request.user, item_id=pk, reason=request.data.get("reason", ""))
        return Response(ReviewItemSerializer(_items().get(pk=pk)).data)


# --- Product Mapping Review ----------------------------------------------------------------

class SourceProductSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_review_status_display", read_only=True)
    product_name = serializers.SerializerMethodField()
    product_is_active = serializers.SerializerMethodField()
    decided_by_name = serializers.CharField(source="decided_by.display_name", read_only=True, default="")
    open_exceptions = serializers.SerializerMethodField()
    approved_prices = serializers.SerializerMethodField()
    price_unresolved = serializers.SerializerMethodField()

    def get_price_unresolved(self, obj) -> bool:
        """True while the sheets give no selling price and the Owner has not approved one."""
        return "MISSING_PRICE" in obj.flags and not any(
            p.price_type == ApprovedPrice.PriceType.SELLING and p.amount > 0 for p in obj.approved_prices.all())

    class Meta:
        model = SourceProduct
        fields = ["id", "serial_number", "source_name", "pack_text", "description_text", "first_seen", "last_seen", "record_count",
                  "selling_prices", "purchase_prices", "flags", "proposed_name", "proposed_unit", "proposed_package_size",
                  "review_status", "status_label", "confirmed_name", "confirmed_unit", "confirmed_package_size", "product",
                  "product_name", "product_is_active", "decision_note", "decided_by_name", "decided_at", "open_exceptions",
                  "approved_prices", "price_unresolved"]

    def get_product_name(self, obj) -> str:
        return str(obj.product) if obj.product else ""

    def get_product_is_active(self, obj):
        return obj.product.is_active if obj.product else None

    def get_open_exceptions(self, obj) -> list:
        return [{"id": i.pk, "kind": i.kind, "title": i.title} for i in obj.review_items.all() if i.status == "PENDING_REVIEW"]

    def get_approved_prices(self, obj) -> list:
        return [{"price_type": p.price_type, "amount": str(p.amount), "effective_date": p.effective_date,
                 "approved_by": p.approved_by.display_name, "note": p.note} for p in obj.approved_prices.all()]


class SourceProductListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = SourceProductSerializer

    def get_queryset(self):
        qs = SourceProduct.objects.select_related("product", "decided_by").prefetch_related("review_items", "approved_prices__approved_by")
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(review_status=params["status"])
        if params.get("flag"):
            qs = qs.filter(flags__contains=[params["flag"]])
        if params.get("search"):
            qs = qs.filter(Q(source_name__icontains=params["search"]) | Q(confirmed_name__icontains=params["search"]))
        return qs


class DecideSourceProductSerializer(serializers.Serializer):
    approve = serializers.BooleanField()
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    confirmed_name = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")
    confirmed_unit = serializers.CharField(max_length=30, required=False, allow_blank=True, default="")
    confirmed_package_size = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all(), required=False, allow_null=True, default=None)
    create_product = serializers.BooleanField(required=False, default=False)
    selling_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0, required=False, allow_null=True, default=None)
    cost_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0, required=False, allow_null=True, default=None)


class SourceProductDecideView(APIView):
    """Owner only: confirm what a source product is, and map it to a live product or create one."""

    permission_classes = [IsOwner]

    @extend_schema(request=DecideSourceProductSerializer, responses=SourceProductSerializer)
    def post(self, request, pk):
        ser = DecideSourceProductSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        sp = services.decide_source_product(owner=request.user, source_product_id=pk, **ser.validated_data)
        return Response(SourceProductSerializer(sp).data)


# --- Historical Daily Records --------------------------------------------------------------

class RecordSerializer(serializers.ModelSerializer):
    source_name = serializers.CharField(source="source_product.source_name", read_only=True)
    import_status_label = serializers.CharField(source="get_import_status_display", read_only=True)

    class Meta:
        model = HistoricalRecord
        fields = ["id", "business_date", "source_file", "worksheet", "source_row", "source_product", "source_name", "original",
                  "opening_qty", "purchases_qty", "sold_qty", "closing_qty", "purchase_price", "sales_price", "total_sales",
                  "validation_status", "validation_messages", "import_status", "import_status_label", "incomplete"]


class RecordListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = RecordSerializer

    def get_queryset(self):
        qs = HistoricalRecord.objects.select_related("source_product")
        params = self.request.query_params
        if params.get("date"):
            qs = qs.filter(business_date=params["date"])
        if params.get("date_from"):
            qs = qs.filter(business_date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_date__lte=params["date_to"])
        if params.get("status"):
            qs = qs.filter(import_status=params["status"])
        if params.get("validation"):
            qs = qs.filter(validation_status=params["validation"])
        if params.get("incomplete") == "true":
            qs = qs.filter(incomplete=True)
        if params.get("source_product"):
            qs = qs.filter(source_product_id=params["source_product"])
        if params.get("search"):
            qs = qs.filter(source_product__source_name__icontains=params["search"])
        return qs


# --- Unlabelled rows -----------------------------------------------------------------------

class UnclassifiedRowSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    decided_by_name = serializers.CharField(source="decided_by.display_name", read_only=True, default="")
    history = serializers.SerializerMethodField()

    class Meta:
        model = UnclassifiedRow
        fields = ["id", "business_date", "source_file", "worksheet", "source_row", "original", "proposed_classification",
                  "proposal_basis", "status", "status_label", "classification", "reason", "decided_by_name", "decided_at", "history"]

    def get_history(self, obj) -> list:
        return [{"status": d.status, "status_label": d.get_status_display(), "classification": d.classification, "reason": d.reason,
                 "reviewer": d.decided_by.display_name, "decided_at": d.decided_at} for d in obj.decisions.all()]


class UnclassifiedRowListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = UnclassifiedRowSerializer

    def get_queryset(self):
        qs = UnclassifiedRow.objects.select_related("decided_by").prefetch_related("decisions__decided_by")
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        if params.get("row"):
            qs = qs.filter(source_row=params["row"])
        if params.get("date"):
            qs = qs.filter(business_date=params["date"])
        return qs


class DecideRowsSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.IntegerField(), allow_empty=False, max_length=2000)
    action = serializers.ChoiceField(choices=["CLASSIFY", "EXCLUDE", "FLAG"])
    classification = serializers.CharField(max_length=80, required=False, allow_blank=True, default="")
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


class UnclassifiedRowDecideView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=DecideRowsSerializer, responses={200: dict})
    def post(self, request):
        ser = DecideRowsSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        rows = services.decide_rows(user=request.user, row_ids=data["ids"], action=data["action"],
                                    classification=data["classification"], reason=data["reason"])
        return Response({"updated": len(rows)})


# --- Downloadable exception report ---------------------------------------------------------

def _flatten(details: dict) -> str:
    parts = []
    for line in details.get("affected_products", []) + details.get("lines", []):
        if "closing_before" in line:
            parts.append(f"{line['product']}: closing {line['closing_before']} ({line['before']['worksheet']} row {line['before']['row']}) "
                         f"-> opening {line['opening_after']} ({line['after']['worksheet']} row {line['after']['row']})")
        elif "sales_price_history" in line:
            prices = ", ".join(f"{h['amount']} ({h['from']} to {h['to']})" for h in line["sales_price_history"])
            parts.append(f"S/N {line['serial']} {line['name']}: sales price {prices}")
        elif "problems" in line:
            parts.append(f"{line['product']} ({line['worksheet']} row {line['row']}): {' '.join(line['problems'])}")
    if "old_value" in details:
        parts.append(f"{details['workbook_column']}: {details['old_value']} ({details['old_source']['worksheet']} row {details['old_source']['row']}) "
                     f"-> {details['new_value']} ({details['new_source']['worksheet']} row {details['new_source']['row']})")
    if "missing_dates" in details:
        parts.insert(0, "Missing: " + ", ".join(details["missing_dates"]))
    if "latest" in details:
        parts.append(f"{details['latest']['worksheet']} row {details['latest']['row']}")
    if "reason" in details:
        parts.append(details["reason"])
    return " | ".join(parts)


class ExceptionReportView(APIView):
    """One file listing every exception, unresolved mapping and unlabelled row, for the Owner and Accountant."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: str})
    def get(self, request):
        state = services.dashboard()
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="meriba_historical_exceptions_{local_today()}.csv"'
        response.write("﻿")
        writer = csv.writer(response)
        writer.writerow(["MERIBA historical data exception report", str(local_today())])
        writer.writerow(["Reconciliation status", state["statement"]])
        writer.writerow(["Waiting for review", f"{state['blockers']['exceptions']} exceptions, "
                         f"{state['blockers']['product_mappings']} product mappings, {state['blockers']['unlabelled_rows']} unlabelled rows"])
        writer.writerow([])
        writer.writerow(["Section", "Type", "Severity", "Status", "Dates", "What was found", "Source details", "Decision", "Note",
                         "Evidence", "Decided by", "Decided on"])
        for item in ReviewItem.objects.select_related("decided_by").order_by("status", "kind", "date_from"):
            dates = "" if not item.date_from else str(item.date_from) if item.date_from == item.date_to else f"{item.date_from} to {item.date_to}"
            writer.writerow(["Exception", item.get_kind_display(), item.get_severity_display(), item.get_status_display(), dates,
                             item.title, _flatten(item.details), services.RESOLUTION_LABELS.get(item.resolution, ""), item.note,
                             item.evidence_reference, getattr(item.decided_by, "display_name", ""),
                             item.decided_at.date() if item.decided_at else ""])
        for sp in SourceProduct.objects.select_related("decided_by", "product").order_by("review_status", "serial_number"):
            prices = "; ".join(f"sales {h['amount']} ({h['from']} to {h['to']})" for h in sp.selling_prices) or "no sales price recorded"
            writer.writerow(["Product mapping", ", ".join(sp.flags) or "No flags", "", sp.get_review_status_display(),
                             f"{sp.first_seen} to {sp.last_seen}", f"S/N {sp.serial_number}: {sp.source_name}",
                             f"{prices}; pack '{sp.pack_text}' size '{sp.description_text}'",
                             f"Mapped to {sp.product}" if sp.product else "", sp.decision_note, "",
                             getattr(sp.decided_by, "display_name", ""), sp.decided_at.date() if sp.decided_at else ""])
        for row in UnclassifiedRow.objects.select_related("decided_by").order_by("status", "business_date", "source_row"):
            cells = "; ".join(f"{c['column']}={c['value']}" for c in row.original)
            writer.writerow(["Unlabelled row", f"Proposed: {row.proposed_classification}", "", row.get_status_display(),
                             str(row.business_date), f"{row.worksheet} row {row.source_row}", cells, row.classification, row.reason,
                             row.proposal_basis, getattr(row.decided_by, "display_name", ""),
                             row.decided_at.date() if row.decided_at else ""])
        audit(request.user, "report.exported", summary="Exported the historical data exception report")
        return response


def _empty_profit_cells():
    """Profit cells the workbook left empty on a line that has sales. Nothing here is filled in or changed."""
    return (HistoricalRecord.objects.filter(profit__isnull=True, sold_qty__gt=0).exclude(import_status="REJECTED")
            .select_related("source_product", "profit_correction", "profit_correction__approved_by").order_by("business_date", "source_row"))


def _empty_profit_cell(record) -> dict:
    known = record.purchase_price is not None and record.sales_price is not None
    correction = getattr(record, "profit_correction", None)
    return {
        "id": record.pk, "date": record.business_date, "worksheet": record.worksheet, "row": record.source_row,
        "product": record.source_product.source_name, "sales": str(record.sold_qty.normalize()),
        "purchase_price": None if record.purchase_price is None else str(record.purchase_price),
        "sales_price": None if record.sales_price is None else str(record.sales_price),
        "written": None,  # the cell is empty in the workbook and stays empty here
        "formula_would_give": str((record.sold_qty * (record.sales_price - record.purchase_price)).quantize(Decimal("0.01"))) if known else None,
        "correction": None if correction is None else {
            "approved_value": str(correction.approved_value), "reason": correction.reason,
            "approved_by": correction.approved_by.get_full_name() or correction.approved_by.username, "approved_at": correction.approved_at},
    }


class EmptyProfitCellListView(APIView):
    """The empty Profit cells, flagged for the Owner's review."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        cells = [_empty_profit_cell(r) for r in _empty_profit_cells()]
        return Response({"cells": cells, "count": len(cells), "awaiting_review": sum(1 for c in cells if c["correction"] is None)})


class ProfitCorrectionSerializer(serializers.Serializer):
    approved_value = serializers.DecimalField(max_digits=18, decimal_places=2)
    reason = serializers.CharField(max_length=500, min_length=5)


class EmptyProfitCellCorrectView(APIView):
    """The Owner approves a figure for one empty Profit cell. The record keeps its empty cell; the approval is kept beside it."""

    permission_classes = [IsOwner]

    @extend_schema(request=ProfitCorrectionSerializer, responses={201: dict})
    def post(self, request, pk):
        from .models import ProfitCellCorrection

        data = ProfitCorrectionSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        record = _empty_profit_cells().filter(pk=pk).first()
        if record is None:
            raise BusinessRuleError("We could not find that empty Profit cell.", code="not_found", status_code=404)
        if hasattr(record, "profit_correction"):
            raise BusinessRuleError("A correction has already been approved for this cell. It cannot be replaced.", code="already_corrected")
        correction = ProfitCellCorrection.objects.create(record=record, approved_by=request.user, **data.validated_data)
        where = f"{record.worksheet} row {record.source_row} {record.source_product.source_name}"
        audit(request.user, "history.profit_correction_approved", record, reason=correction.reason,
              summary=f"Approved Profit of {correction.approved_value:,.0f} for the empty cell at {where}",
              before={"profit": None}, after={"approved_profit": correction.approved_value})
        record.profit_correction = correction
        return Response(_empty_profit_cell(record), status=201)
