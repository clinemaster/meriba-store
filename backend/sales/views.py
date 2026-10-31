from django.db import IntegrityError
from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant, IsSignedIn
from catalog.models import Product, ProductUnit
from core.errors import BusinessRuleError

from . import services
from .models import Payment, PaymentMethod, PaymentProvider, Refund, Sale, SaleItem


class SaleItemSerializer(serializers.ModelSerializer):
    refunded_quantity = serializers.SerializerMethodField()

    class Meta:
        model = SaleItem
        fields = ["id", "product", "product_name", "unit_name", "quantity", "unit_price", "line_total", "refunded_quantity"]

    def get_refunded_quantity(self, obj) -> str:
        return str(sum((r.quantity for r in obj.refund_items.all()), 0))


class RefundSerializer(serializers.ModelSerializer):
    method_name = serializers.CharField(source="method.name", read_only=True)
    created_by_name = serializers.CharField(source="created_by.display_name", read_only=True)
    business_date = serializers.DateField(source="business_day.date", read_only=True)
    receipt_number = serializers.CharField(source="sale.receipt_number", read_only=True)
    items = serializers.SerializerMethodField()

    class Meta:
        model = Refund
        fields = ["id", "sale", "receipt_number", "business_date", "created_at", "total", "method", "method_name",
                  "provider", "provider_name", "reason", "reference", "created_by_name", "items"]

    def get_items(self, obj) -> list:
        return [{"sale_item": i.sale_item_id, "product_name": i.sale_item.product_name, "quantity": str(i.quantity),
                 "amount": str(i.amount), "restocked": i.restocked} for i in obj.items.select_related("sale_item")]


class PaymentSerializer(serializers.ModelSerializer):
    method_name = serializers.CharField(source="method.name", read_only=True)
    method_icon = serializers.CharField(source="method.icon", read_only=True)
    is_cash = serializers.BooleanField(source="method.is_cash", read_only=True)

    class Meta:
        model = Payment
        fields = ["id", "method", "method_name", "method_icon", "is_cash", "provider", "provider_name", "amount", "tendered",
                  "reference", "status", "created_at"]


class SaleSerializer(serializers.ModelSerializer):
    items = SaleItemSerializer(many=True, read_only=True)
    payments = PaymentSerializer(many=True, read_only=True)
    cashier_name = serializers.CharField(source="cashier.display_name", read_only=True)
    business_date = serializers.DateField(source="business_day.date", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    voided_by_name = serializers.CharField(source="voided_by.display_name", read_only=True, default="")
    refunds = RefundSerializer(many=True, read_only=True)
    refunded_total = serializers.SerializerMethodField()

    def get_refunded_total(self, obj) -> str:
        return str(sum((r.total for r in obj.refunds.all()), 0))

    class Meta:
        model = Sale
        fields = [
            "id", "receipt_number", "status", "status_label", "business_date", "created_at", "cashier", "cashier_name",
            "subtotal", "discount_total", "total", "amount_tendered", "change_due", "items", "payments",
            "voided_at", "voided_by_name", "void_reason", "refunds", "refunded_total",
        ]


class SaleLineInput(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    unit = serializers.PrimaryKeyRelatedField(queryset=ProductUnit.objects.all(), required=False, allow_null=True)
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)


class SalePaymentInput(serializers.Serializer):
    method = serializers.PrimaryKeyRelatedField(queryset=PaymentMethod.objects.all())
    provider = serializers.PrimaryKeyRelatedField(queryset=PaymentProvider.objects.all(), required=False, allow_null=True, default=None)
    amount = serializers.DecimalField(max_digits=16, decimal_places=2)
    reference = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")


class SaleCreateSerializer(serializers.Serializer):
    """Prices are never accepted from the screen; the server always uses the product's current price."""

    request_key = serializers.UUIDField()
    items = SaleLineInput(many=True, allow_empty=False, error_messages={"empty": "Add at least one product to the sale."})
    payments = SalePaymentInput(many=True, allow_empty=False, error_messages={"empty": "Choose how the customer is paying."})


class SaleListCreateView(generics.ListAPIView):
    permission_classes = [IsSignedIn]
    serializer_class = SaleSerializer

    def get_queryset(self):
        qs = Sale.objects.select_related("cashier", "business_day", "voided_by").prefetch_related("items__refund_items", "payments__method", "refunds__method")
        user, params = self.request.user, self.request.query_params
        if not user.is_back_office:
            qs = qs.filter(cashier=user)  # a cashier only ever sees their own sales
        elif params.get("cashier"):
            qs = qs.filter(cashier_id=params["cashier"])
        if params.get("shift"):
            qs = qs.filter(shift_id=params["shift"])
        if params.get("date"):
            qs = qs.filter(business_day__date=params["date"])
        if params.get("date_from"):
            qs = qs.filter(business_day__date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_day__date__lte=params["date_to"])
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        if params.get("search"):
            qs = qs.filter(receipt_number__icontains=params["search"].strip())
        return qs

    @extend_schema(request=SaleCreateSerializer, responses={201: SaleSerializer, 200: SaleSerializer})
    def post(self, request):
        ser = SaleCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            sale, created = services.create_sale(
                cashier=request.user, request_key=data["request_key"], items=data["items"], payments=data["payments"]
            )
        except IntegrityError:
            # Two copies of the same request arrived together; one saved, so return that one.
            sale = Sale.objects.filter(request_key=data["request_key"], cashier=request.user).first()
            if sale is None:
                raise
            created = False
        body = SaleSerializer(sale).data
        body["already_saved"] = not created
        return Response(body, status=201 if created else 200)


def _sale_for(request, pk) -> Sale:
    qs = Sale.objects.select_related("cashier", "business_day", "voided_by")
    if not request.user.is_back_office:
        qs = qs.filter(cashier=request.user)
    sale = qs.filter(pk=pk).first()
    if sale is None:
        raise BusinessRuleError("We could not find that sale.", code="not_found", status_code=404)
    return sale


class SaleDetailView(APIView):
    """Read-only: there is deliberately no way to edit or delete a sale through the API."""

    permission_classes = [IsSignedIn]

    @extend_schema(responses=SaleSerializer)
    def get(self, request, pk):
        return Response(SaleSerializer(_sale_for(request, pk)).data)


class VoidSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)


class SaleVoidView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=VoidSerializer, responses=SaleSerializer)
    def post(self, request, pk):
        ser = VoidSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        sale, _ = services.void_sale(sale_id=pk, actor=request.user, reason=ser.validated_data["reason"])
        return Response(SaleSerializer(_sale_for(request, sale.pk)).data)


class RefundLineInput(serializers.Serializer):
    sale_item = serializers.PrimaryKeyRelatedField(queryset=SaleItem.objects.select_related("product"))
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    restock = serializers.BooleanField(default=True)


class RefundCreateSerializer(serializers.Serializer):
    request_key = serializers.UUIDField()
    reason = serializers.CharField(max_length=300)
    method = serializers.PrimaryKeyRelatedField(queryset=PaymentMethod.objects.all())
    provider = serializers.PrimaryKeyRelatedField(queryset=PaymentProvider.objects.all(), required=False, allow_null=True, default=None)
    shift = serializers.IntegerField(required=False, allow_null=True)
    reference = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")
    lines = RefundLineInput(many=True, allow_empty=False, error_messages={"empty": "Choose at least one item to refund."})


class SaleRefundView(APIView):
    """Owner/Accountant: refund items of a completed sale. Recorded on today's open business day."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=RefundCreateSerializer, responses={201: SaleSerializer})
    def post(self, request, pk):
        from trading.models import CashierShift

        ser = RefundCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        shift = CashierShift.objects.filter(pk=data.get("shift")).first() if data.get("shift") else None
        _, created = services.refund_sale(
            sale_id=pk, actor=request.user, request_key=data["request_key"], lines=data["lines"], method=data["method"],
            reason=data["reason"], shift=shift, reference=data["reference"], provider=data["provider"],
        )
        return Response(SaleSerializer(_sale_for(request, pk)).data, status=201 if created else 200)


class RefundListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = RefundSerializer

    def get_queryset(self):
        qs = Refund.objects.select_related("sale", "method", "created_by", "business_day")
        params = self.request.query_params
        if params.get("date_from"):
            qs = qs.filter(business_day__date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_day__date__lte=params["date_to"])
        return qs