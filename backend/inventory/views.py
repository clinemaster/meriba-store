from django.db.models import Prefetch
from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwner, IsOwnerOrAccountant
from catalog import stock_levels
from catalog.models import Product
from core.errors import BusinessRuleError
from core.services import get_branch

from . import services
from .models import InventoryMovement, OpeningCount, OpeningCountLine, StockAdjustment, StockAlert, StockBalance


class MovementSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.__str__", read_only=True)
    type_label = serializers.CharField(source="get_movement_type_display", read_only=True)
    user_name = serializers.CharField(source="user.display_name", read_only=True)

    class Meta:
        model = InventoryMovement
        fields = [
            "id", "created_at", "business_date", "product", "product_name", "movement_type", "type_label",
            "quantity_delta", "balance_before", "balance_after", "source_type", "source_id", "user_name", "reason",
        ]


class MovementListView(generics.ListAPIView):
    """Stock movement history. Back office only: cashiers cannot view or edit stock records."""

    permission_classes = [IsOwnerOrAccountant]
    serializer_class = MovementSerializer

    def get_queryset(self):
        qs = InventoryMovement.objects.filter(branch=get_branch()).select_related("product", "user")
        params = self.request.query_params
        if params.get("product"):
            qs = qs.filter(product_id=params["product"])
        if params.get("type"):
            qs = qs.filter(movement_type=params["type"])
        if params.get("date_from"):
            qs = qs.filter(business_date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_date__lte=params["date_to"])
        return qs


class StockAlertView(APIView):
    """Products whose stock level got worse, newest first. Back office only.

    `?after=<id>` returns only alerts newer than the last one the screen has shown, so each is announced once.
    `latest_id` lets a screen that has shown nothing yet start from now instead of announcing the past.
    """

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        branch = get_branch()
        qs = StockAlert.objects.filter(branch=branch)
        latest = qs.values_list("id", flat=True).first() or 0
        try:
            after = int(request.query_params.get("after", ""))
        except ValueError:
            after = None
        if after is not None:
            qs = qs.filter(id__gt=after)
        alerts = list(qs.select_related("product")[:20])
        now = dict(StockBalance.objects.filter(branch=branch, product__in=[a.product_id for a in alerts]).values_list("product", "quantity"))
        return Response({"latest_id": latest, "results": [{
            "id": a.id, "created_at": a.created_at, "product": a.product_id, "product_name": str(a.product), "unit": a.product.base_unit,
            "status_before": a.status_before, "status": a.status_after, "status_label": stock_levels.LABELS[a.status_after],
            "quantity": a.quantity,
            # Where it stands now: a delivery since the alert may already have put it right.
            "current_status": stock_levels.stock_status(now.get(a.product_id), a.product.reorder_point, a.product.critical_point),
        } for a in alerts]})


class CountLineSerializer(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    quantity = serializers.DecimalField(max_digits=14, decimal_places=3, min_value=0)


def _unique_products(lines):
    ids = [line["product"].pk for line in lines]
    if len(ids) != len(set(ids)):
        raise serializers.ValidationError("Each product can appear only once.")
    return lines


class CountSerializer(serializers.Serializer):
    request_key = serializers.UUIDField()
    reason = serializers.CharField(max_length=300)
    kind = serializers.ChoiceField(
        choices=[StockAdjustment.Kind.COUNT, StockAdjustment.Kind.DAMAGE, StockAdjustment.Kind.OTHER],
        default=StockAdjustment.Kind.COUNT,
    )
    lines = CountLineSerializer(many=True, allow_empty=False)

    def validate_lines(self, lines):
        return _unique_products(lines)


class StockAdjustmentView(APIView):
    """After go-live: correct a product's quantity to what was physically counted, with a reason."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=CountSerializer, responses={201: dict})
    def post(self, request):
        ser = CountSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        adjustment, created = services.record_count(
            user=request.user, kind=data["kind"], reason=data["reason"], request_key=data["request_key"],
            lines=[(line["product"], line["quantity"]) for line in data["lines"]],
        )
        return Response(
            {"id": adjustment.pk, "kind": adjustment.kind, "lines": adjustment.lines.count(), "already_saved": not created},
            status=201 if created else 200,
        )


# --- Opening stock count sheets -------------------------------------------------------------

class OpeningCountSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    prepared_by_name = serializers.CharField(source="prepared_by.display_name", read_only=True)
    reviewed_by_name = serializers.CharField(source="reviewed_by.display_name", read_only=True, default="")
    lines = serializers.SerializerMethodField()

    class Meta:
        model = OpeningCount
        fields = ["id", "count_date", "counted_by_name", "note", "status", "status_label", "created_at", "prepared_by_name",
                  "reviewed_by_name", "reviewed_at", "review_note", "lines"]

    def get_lines(self, obj) -> list:
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("lines")
        lines = prefetched if prefetched is not None else obj.lines.select_related("product")
        return [
            {"product": line.product_id, "product_name": str(line.product), "unit": line.unit,
             "counted_quantity": str(line.counted_quantity),
             "reference_quantity": None if line.reference_quantity is None else str(line.reference_quantity),
             "reference_source": line.reference_source,
             "variance": None if line.variance is None else str(line.variance),
             "approved_quantity": None if line.approved_quantity is None else str(line.approved_quantity),
             "movement": line.movement_id}
            for line in lines
        ]


class OpeningCountInput(serializers.Serializer):
    request_key = serializers.UUIDField()
    count_date = serializers.DateField()
    counted_by_name = serializers.CharField(max_length=120)
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    lines = CountLineSerializer(many=True, allow_empty=False, error_messages={"empty": "Enter the counted quantity for at least one product."})

    def validate_lines(self, lines):
        return _unique_products(lines)


class OpeningCountView(generics.ListAPIView):
    """Owner or Accountant prepares the physical count sheet. Saving it does not change stock."""

    permission_classes = [IsOwnerOrAccountant]
    serializer_class = OpeningCountSerializer
    pagination_class = None

    def get_queryset(self):
        return (OpeningCount.objects.filter(branch=get_branch())
                .select_related("prepared_by", "reviewed_by")
                .prefetch_related(Prefetch("lines", queryset=OpeningCountLine.objects.select_related("product"))))

    def list(self, request, *args, **kwargs):
        state = services.opening_stock_state(get_branch())
        return Response({"state": state, "counts": OpeningCountSerializer(self.get_queryset(), many=True).data})

    @extend_schema(request=OpeningCountInput, responses={201: OpeningCountSerializer})
    def post(self, request):
        return _save_opening_count(request, None)


def _save_opening_count(request, count_id):
    ser = OpeningCountInput(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    count, created = services.save_opening_count(
        user=request.user, request_key=data["request_key"], count_date=data["count_date"],
        counted_by_name=data["counted_by_name"], note=data["note"], count_id=count_id,
        lines=[(line["product"], line["quantity"]) for line in data["lines"]],
    )
    return Response(OpeningCountSerializer(count).data, status=201 if created else 200)


class OpeningCountDetailView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses=OpeningCountSerializer)
    def get(self, request, pk):
        count = OpeningCount.objects.filter(pk=pk, branch=get_branch()).first()
        if count is None:
            raise BusinessRuleError("We could not find that count sheet.", code="not_found", status_code=404)
        return Response(OpeningCountSerializer(count).data)

    @extend_schema(request=OpeningCountInput, responses=OpeningCountSerializer)
    def put(self, request, pk):
        return _save_opening_count(request, pk)

class OpeningCountReviewSerializer(serializers.Serializer):
    approve = serializers.BooleanField()
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class OpeningCountReviewView(APIView):
    """Owner only. Approving posts the counted quantities to the live stock ledger."""

    permission_classes = [IsOwner]

    @extend_schema(request=OpeningCountReviewSerializer, responses=OpeningCountSerializer)
    def post(self, request, pk):
        ser = OpeningCountReviewSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        count = services.review_opening_count(owner=request.user, count_id=pk, **ser.validated_data)
        return Response(OpeningCountSerializer(count).data)
