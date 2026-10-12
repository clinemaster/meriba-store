from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwner, IsOwnerOrAccountant
from catalog.models import Product
from core.services import get_branch

from . import services
from .models import InventoryMovement, StockAdjustment


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


class CountLineSerializer(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    quantity = serializers.DecimalField(max_digits=14, decimal_places=3, min_value=0)


class CountSerializer(serializers.Serializer):
    request_key = serializers.UUIDField()
    reason = serializers.CharField(max_length=300)
    kind = serializers.ChoiceField(
        choices=[StockAdjustment.Kind.COUNT, StockAdjustment.Kind.DAMAGE, StockAdjustment.Kind.OTHER],
        default=StockAdjustment.Kind.COUNT,
    )
    lines = CountLineSerializer(many=True, allow_empty=False)

    def validate_lines(self, lines):
        ids = [line["product"].pk for line in lines]
        if len(ids) != len(set(ids)):
            raise serializers.ValidationError("Each product can appear only once.")
        return lines


def _count_response(adjustment, created):
    return Response(
        {"id": adjustment.pk, "kind": adjustment.kind, "lines": adjustment.lines.count(), "already_saved": not created},
        status=201 if created else 200,
    )


class OpeningStockView(APIView):
    """Owner or Accountant enters the physically counted opening quantities; the Owner approves them."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=CountSerializer, responses={201: dict})
    def post(self, request):
        ser = CountSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        adjustment, created = services.record_count(
            user=request.user, kind=StockAdjustment.Kind.OPENING, reason=data["reason"],
            request_key=data["request_key"], lines=[(line["product"], line["quantity"]) for line in data["lines"]],
        )
        return _count_response(adjustment, created)


class OpeningStockConfirmView(APIView):
    permission_classes = [IsOwner]

    @extend_schema(request=None, responses={200: dict})
    def post(self, request):
        cfg = services.confirm_opening_stock(user=request.user, approved=request.data.get("approved", True) is not False)
        return Response({"opening_stock_confirmed_at": cfg.opening_stock_confirmed_at})


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
        return _count_response(adjustment, created)
