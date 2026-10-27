"""Upload Received Stock: template, upload with preview, re-check after choices, and confirmation.

Owner only (owner's decision, 21 Oct 2026), enforced here as well as on the screen. Typing a delivery on
Receive Stock is unchanged: Owner and Accountant.
"""
from decimal import Decimal

from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwner
from core.errors import BusinessRuleError
from core.services import get_branch, get_settings
from history.parser import file_digest

from . import receipt_import
from .models import ReceiptImport, Supplier


def _plain(value):
    if isinstance(value, Decimal):
        return str(value.normalize()) if value != value.to_integral_value() else str(int(value))
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _preview(batch: ReceiptImport) -> dict:
    earlier = receipt_import.previous_import(batch)
    return _plain({
        "batch": str(batch.pk), "file": batch.file_name, "status": batch.status, "uploaded_at": batch.created_at,
        "is_live": get_settings(batch.branch).is_live,
        "already_imported": None if earlier is None else {
            "batch": str(earlier.pk), "imported_at": earlier.confirmed_at, "by": earlier.confirmed_by.display_name,
            "receipts": list(earlier.receipts.values_list("id", flat=True)),
        },
        **receipt_import.analyse(batch.rows, batch.edits, batch.decisions),
        "edits": batch.edits, "decisions": batch.decisions,
        "result": batch.result,
    })


class ReceiptImportTemplateView(APIView):
    permission_classes = [IsOwner]

    @extend_schema(responses={200: bytes})
    def get(self, request):
        response = HttpResponse(receipt_import.template(),
                                content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        response["Content-Disposition"] = 'attachment; filename="meriba_received_stock_template.xlsx"'
        return response


class ReceiptImportView(APIView):
    """Upload a workbook. It is read and checked; stock is not touched."""

    permission_classes = [IsOwner]
    parser_classes = [MultiPartParser]

    @extend_schema(request=None, responses={201: dict})
    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise BusinessRuleError("Choose the Excel file to upload.", code="no_file", status_code=400)
        data = upload.read()
        rows = receipt_import.read_workbook(data, upload.name)
        batch = ReceiptImport.objects.create(branch=get_branch(), file_name=upload.name[:200], file_hash=file_digest(data),
                                             rows=rows, uploaded_by=request.user)
        return Response(_preview(batch), status=201)


class ReviewInput(serializers.Serializer):
    # By Excel row number: {"product": id, "unit": "Crate", "volume": "750", "quantity": "24", "excluded": true}
    edits = serializers.DictField(child=serializers.DictField(), required=False)
    # By product id: "combine" or "separate"
    decisions = serializers.DictField(child=serializers.ChoiceField(choices=["combine", "separate"]), required=False)


class ReceiptImportPreviewView(APIView):
    """The upload as it stands (GET), or with the Owner's corrections saved and everything checked again (POST).
    Neither changes stock."""

    permission_classes = [IsOwner]

    def _batch(self, pk):
        batch = ReceiptImport.objects.filter(pk=pk, branch=get_branch()).first()
        if batch is None:
            raise BusinessRuleError("We could not find that upload. Upload the file again.", code="not_found", status_code=404)
        return batch

    @extend_schema(responses={200: dict})
    def get(self, request, pk):
        return Response(_preview(self._batch(pk)))

    @extend_schema(request=ReviewInput, responses={200: dict})
    def post(self, request, pk):
        data = ReviewInput(data=request.data)
        data.is_valid(raise_exception=True)
        batch = receipt_import.save_review(batch_id=pk, user=request.user, edits=data.validated_data.get("edits"),
                                           decisions=data.validated_data.get("decisions"))
        return Response(_preview(batch))


class ConfirmInput(serializers.Serializer):
    supplier = serializers.PrimaryKeyRelatedField(queryset=Supplier.objects.all(), required=False, allow_null=True)
    reference = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")
    note = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")
    reimport_reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class ReceiptImportConfirmView(APIView):
    """Add the ready rows to stock, as stock receipts. All or nothing; a repeated press changes nothing."""

    permission_classes = [IsOwner]

    @extend_schema(request=ConfirmInput, responses={200: dict})
    def post(self, request, pk):
        data = ConfirmInput(data=request.data)
        data.is_valid(raise_exception=True)
        batch, created = receipt_import.confirm(batch_id=pk, user=request.user, **data.validated_data)
        return Response({"created": created, "batch": str(batch.pk), "result": batch.result}, status=201 if created else 200)
