from decimal import Decimal

from django.db import transaction
from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant
from catalog.models import Product
from core.errors import BusinessRuleError
from core.services import audit, get_branch, get_settings, money
from inventory.models import InventoryMovement
from inventory.services import current_business_date, post_movement
from sales.models import PaymentMethod
from trading.models import CashierShift

from .models import Expense, GoodsReceipt, GoodsReceiptLine, Supplier


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = ["id", "name", "phone", "notes", "is_active"]


class SupplierViewSet(viewsets.ModelViewSet):
    permission_classes = [IsOwnerOrAccountant]
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch"]

    def perform_create(self, serializer):
        supplier = serializer.save()
        audit(self.request.user, "supplier.created", supplier, summary=f"Added supplier '{supplier.name}'")


# --- Receiving stock ------------------------------------------------------------

class ReceiptLineInput(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    quantity = serializers.DecimalField(max_digits=14, decimal_places=3)
    unit_cost = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0, required=False, allow_null=True)


class ReceiptCreateSerializer(serializers.Serializer):
    request_key = serializers.UUIDField()
    supplier = serializers.PrimaryKeyRelatedField(queryset=Supplier.objects.all(), required=False, allow_null=True)
    reference = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    update_cost_price = serializers.BooleanField(default=False)
    lines = ReceiptLineInput(many=True, allow_empty=False, error_messages={"empty": "Add at least one product that was received."})


class ReceiptSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source="supplier.name", read_only=True, default="")
    received_by_name = serializers.CharField(source="received_by.display_name", read_only=True)
    lines = serializers.SerializerMethodField()

    class Meta:
        model = GoodsReceipt
        fields = ["id", "business_date", "created_at", "supplier", "supplier_name", "reference", "note", "total_cost",
                  "received_by_name", "lines"]

    def get_lines(self, obj) -> list:
        return [{"product": line.product_id, "product_name": str(line.product), "quantity": str(line.quantity),
                 "unit_cost": None if line.unit_cost is None else str(line.unit_cost),
                 "line_cost": None if line.line_cost is None else str(line.line_cost)}
                for line in obj.lines.select_related("product")]


@transaction.atomic
def receive_stock(*, user, request_key, lines, supplier=None, reference="", note="", update_cost_price=False):
    """Confirmed receipt of goods: one stock movement per product, linked to this receipt (FR-PUR-02/03)."""
    existing = GoodsReceipt.objects.filter(request_key=request_key).first()
    if existing:
        return existing, False
    branch = get_branch()
    if not get_settings(branch).is_live:
        raise BusinessRuleError("Stock can be received after the shop goes live. Before that, use the opening stock count.", code="not_live")
    ids = [line["product"].pk for line in lines]
    if len(ids) != len(set(ids)):
        raise BusinessRuleError("Each product can appear only once in a delivery.", code="duplicate_product", status_code=400)
    for line in lines:
        qty = Decimal(line["quantity"])
        if qty <= 0 or qty != qty.to_integral_value():
            raise BusinessRuleError(f"Enter a whole quantity greater than zero for {line['product']}.", code="bad_quantity", status_code=400)

    business_date = current_business_date(branch)
    receipt = GoodsReceipt.objects.create(
        branch=branch, supplier=supplier, reference=reference.strip(), note=note.strip(), business_date=business_date,
        request_key=request_key, received_by=user,
    )
    total, all_costed = Decimal("0.00"), True
    for line in sorted(lines, key=lambda item: item["product"].pk):
        product, qty, unit_cost = line["product"], Decimal(line["quantity"]), line.get("unit_cost")
        line_cost = None if unit_cost is None else money(qty * unit_cost)
        all_costed = all_costed and line_cost is not None
        total += line_cost or 0
        GoodsReceiptLine.objects.create(receipt=receipt, product=product, quantity=qty, unit_cost=unit_cost, line_cost=line_cost)
        post_movement(
            branch=branch, product=product, delta=qty, movement_type=InventoryMovement.Type.RECEIPT,
            source_type="GoodsReceipt", source_id=receipt.pk, user=user, business_date=business_date,
            reason=f"Received from {supplier}" if supplier else "Stock received",
        )
        if update_cost_price and unit_cost is not None and product.cost_price != unit_cost:
            old = product.cost_price
            product.cost_price = unit_cost
            product.save(update_fields=["cost_price", "updated_at"])
            audit(user, "product.price_changed", product, summary=f"Cost of '{product}' updated from delivery {receipt.pk}",
                  before={"cost_price": old}, after={"cost_price": unit_cost})
    # A total is stored only when every line had a cost; a partial total would mislead.
    receipt.total_cost = total if all_costed else None
    receipt.save(update_fields=["total_cost"])
    audit(user, "stock.received", receipt, summary=f"Received {len(lines)} product(s)" + (f" from {supplier}" if supplier else ""),
          after={"reference": receipt.reference, "total_cost": receipt.total_cost,
                 "lines": {str(line["product"].pk): line["quantity"] for line in lines}})
    return receipt, True


class GoodsReceiptView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = ReceiptSerializer

    def get_queryset(self):
        qs = GoodsReceipt.objects.filter(branch=get_branch()).select_related("supplier", "received_by")
        params = self.request.query_params
        if params.get("date_from"):
            qs = qs.filter(business_date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_date__lte=params["date_to"])
        return qs

    @extend_schema(request=ReceiptCreateSerializer, responses={201: ReceiptSerializer})
    def post(self, request):
        ser = ReceiptCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        receipt, created = receive_stock(
            user=request.user, request_key=data["request_key"], lines=data["lines"], supplier=data.get("supplier"),
            reference=data["reference"], note=data["note"], update_cost_price=data["update_cost_price"],
        )
        return Response(ReceiptSerializer(receipt).data, status=201 if created else 200)


# --- Expenses -------------------------------------------------------------------

EXPENSE_CATEGORIES = ["Rent", "Salaries and wages", "Electricity and water", "Transport", "Licences and fees",
                      "Repairs", "Cleaning and supplies", "Airtime and internet", "Other"]


class ExpenseSerializer(serializers.ModelSerializer):
    method_name = serializers.CharField(source="method.name", read_only=True)
    recorded_by_name = serializers.CharField(source="recorded_by.display_name", read_only=True)
    paid_from_drawer_of = serializers.CharField(source="shift.cashier.display_name", read_only=True, default="")
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = Expense
        fields = ["id", "business_date", "created_at", "category", "description", "amount", "method", "method_name",
                  "shift", "paid_from_drawer_of", "reference", "status", "status_label", "void_reason", "recorded_by_name"]


class ExpenseCreateSerializer(serializers.Serializer):
    request_key = serializers.UUIDField()
    business_date = serializers.DateField(required=False, allow_null=True)
    category = serializers.CharField(max_length=60)
    description = serializers.CharField(max_length=300)
    amount = serializers.DecimalField(max_digits=16, decimal_places=2)
    method = serializers.PrimaryKeyRelatedField(queryset=PaymentMethod.objects.all())
    # Tick when the cash came out of a cashier's drawer during their shift.
    shift = serializers.PrimaryKeyRelatedField(queryset=CashierShift.objects.all(), required=False, allow_null=True)
    reference = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")


class ExpenseView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = ExpenseSerializer

    def get_queryset(self):
        qs = Expense.objects.filter(branch=get_branch()).select_related("method", "recorded_by", "shift__cashier")
        params = self.request.query_params
        if params.get("date_from"):
            qs = qs.filter(business_date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_date__lte=params["date_to"])
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        return qs

    @extend_schema(request=ExpenseCreateSerializer, responses={201: ExpenseSerializer})
    def post(self, request):
        ser = ExpenseCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        with transaction.atomic():
            existing = Expense.objects.filter(request_key=data["request_key"]).first()
            if existing:
                return Response(ExpenseSerializer(existing).data)
            amount = money(data["amount"])
            if amount <= 0:
                raise BusinessRuleError("Enter an amount greater than zero.", code="bad_amount", status_code=400)
            branch = get_branch()
            shift = data.get("shift")
            if shift is not None:
                shift = CashierShift.objects.select_for_update(of=("self",)).select_related("business_day").get(pk=shift.pk)
                if shift.status != CashierShift.Status.OPEN:
                    raise BusinessRuleError("That cashier's shift is already closed, so cash can no longer be taken from its drawer.", code="shift_closed")
                if not data["method"].is_cash:
                    raise BusinessRuleError("Only a cash expense can be paid from a cashier's drawer.", code="not_cash", status_code=400)
            expense = Expense.objects.create(
                branch=branch, category=data["category"].strip(), description=data["description"].strip(), amount=amount,
                method=data["method"], shift=shift, reference=data["reference"].strip(), request_key=data["request_key"],
                business_date=shift.business_day.date if shift else (data.get("business_date") or current_business_date(branch)),
                recorded_by=request.user,
            )
            audit(request.user, "expense.recorded", expense, summary=f"Expense {amount:,.0f}: {expense.category} - {expense.description}"[:255],
                  after={"amount": amount, "method": expense.method.code, "from_drawer_shift": getattr(shift, "pk", None)})
        return Response(ExpenseSerializer(expense).data, status=201)


class ExpenseVoidSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300, min_length=5)


class ExpenseVoidView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=ExpenseVoidSerializer, responses=ExpenseSerializer)
    def post(self, request, pk):
        ser = ExpenseVoidSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            expense = Expense.objects.select_for_update(of=("self",)).select_related("shift").filter(pk=pk).first()
            if expense is None:
                raise BusinessRuleError("We could not find that expense.", code="not_found", status_code=404)
            if expense.status == Expense.Status.RECORDED:
                if expense.shift is not None and expense.shift.status != CashierShift.Status.OPEN:
                    raise BusinessRuleError(
                        "This expense was paid from a drawer that has already been counted and closed, so it cannot be cancelled.",
                        code="shift_closed",
                    )
                expense.status = Expense.Status.VOIDED
                expense.void_reason = ser.validated_data["reason"].strip()
                expense.voided_by = request.user
                expense.save(update_fields=["status", "void_reason", "voided_by"])
                audit(request.user, "expense.voided", expense, reason=expense.void_reason,
                      summary=f"Cancelled expense of {expense.amount:,.0f} ({expense.category})")
        return Response(ExpenseSerializer(expense).data)


class ExpenseCategoriesView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: list})
    def get(self, request):
        used = Expense.objects.values_list("category", flat=True).distinct()
        return Response(sorted(set(EXPENSE_CATEGORIES) | set(used)))
