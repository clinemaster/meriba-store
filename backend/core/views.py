from django.db import connection, transaction
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import IsOwner, IsOwnerOrAccountant, IsSignedIn

from .errors import BusinessRuleError
from .models import AuditLog, BusinessSettings
from .services import audit, get_branch, get_settings, money


@extend_schema(responses={200: dict})
@api_view(["GET"])
@permission_classes([AllowAny])
def health(request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
    return Response({"status": "ok"})


class SettingsSerializer(serializers.ModelSerializer):
    branch_name = serializers.CharField(source="branch.name")
    branch_code = serializers.CharField(source="branch.code", read_only=True)
    is_live = serializers.BooleanField(read_only=True)

    class Meta:
        model = BusinessSettings
        fields = [
            "branch_name", "branch_code", "currency_code", "receipt_header", "receipt_footer",
            "split_payments_enabled", "cash_variance_tolerance", "opening_cumulative_sales",
            "opening_stock_confirmed_at", "went_live_at", "is_live",
        ]
        read_only_fields = ["currency_code", "opening_cumulative_sales", "opening_stock_confirmed_at", "went_live_at"]

    def update(self, instance, validated_data):
        branch_data = validated_data.pop("branch", None)
        if branch_data and branch_data.get("name"):
            instance.branch.name = branch_data["name"]
            instance.branch.save(update_fields=["name"])
        return super().update(instance, validated_data)


class SettingsView(APIView):
    """Shop details. Everyone signed in can read them (receipts need them); only the Owner can change them."""

    def get_permissions(self):
        return [IsSignedIn()] if self.request.method == "GET" else [IsOwner()]

    @extend_schema(responses=SettingsSerializer)
    def get(self, request):
        return Response(SettingsSerializer(get_settings()).data)

    @extend_schema(request=SettingsSerializer, responses=SettingsSerializer)
    def patch(self, request):
        obj = get_settings()
        before = SettingsSerializer(obj).data
        ser = SettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        audit(request.user, "settings.changed", obj, summary="Shop settings changed", before=before, after=ser.data)
        return Response(ser.data)


def setup_steps(branch) -> list[dict]:
    from catalog.models import Product
    from inventory.services import opening_stock_state
    from sales.models import PaymentMethod

    products = Product.objects.filter(is_active=True)
    stock = opening_stock_state(branch)
    stock_detail = ("A count sheet is waiting for the Owner's review" if stock["pending"] else
                    f"{stock['uncounted']} product(s) on sale have no approved count yet" if stock["uncounted"] else "Approved")
    return [
        {"key": "products", "title": "Add your products and selling prices",
         "done": products.exists(), "detail": f"{products.count()} active products"},
        {"key": "prices", "title": "Every active product has a selling price",
         "done": products.exists() and not products.filter(selling_price__lte=0).exists(),
         "detail": f"{products.filter(selling_price__lte=0).count()} products without a price"},
        {"key": "payment_methods", "title": "Choose the payment methods you accept",
         "done": PaymentMethod.objects.filter(is_active=True).exists(),
         "detail": ", ".join(PaymentMethod.objects.filter(is_active=True).values_list("name", flat=True))},
        {"key": "opening_stock", "title": "Count the stock physically and have the Owner approve the count",
         "done": stock["complete"], "detail": stock_detail},
        {"key": "cashier", "title": "Create at least one cashier account",
         "done": User.objects.filter(role=User.Role.CASHIER, is_active=True).exists(), "detail": ""},
    ]


class SetupStatusView(APIView):
    """Owner and Accountant can both follow the setup; only the Owner can approve and go live."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        branch = get_branch()
        cfg = get_settings(branch)
        steps = setup_steps(branch)
        prepared = cfg.prepared_opening_cumulative_sales
        return Response({
            "is_live": cfg.is_live,
            "went_live_at": cfg.went_live_at,
            "opening_cumulative_sales": str(cfg.opening_cumulative_sales),
            "prepared_opening_cumulative_sales": None if prepared is None else str(prepared),
            "opening_balance_as_of": cfg.opening_balance_as_of,
            "opening_balance_note": cfg.opening_balance_note,
            "opening_balance_prepared_by": getattr(cfg.opening_balance_prepared_by, "display_name", ""),
            "opening_stock": opening_stock_state_for(branch),
            "steps": steps,
            "ready_to_go_live": all(s["done"] for s in steps),
        })


class OpeningBalanceSerializer(serializers.Serializer):
    opening_cumulative_sales = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=0)
    as_of_date = serializers.DateField()
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class PrepareOpeningBalanceView(APIView):
    """Before go-live: record the reconciled opening cumulative sales figure for the Owner to approve.

    Preparing a figure approves nothing. It only takes effect when the Owner goes live with it.
    """

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=OpeningBalanceSerializer, responses={200: dict})
    def put(self, request):
        ser = OpeningBalanceSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            cfg = BusinessSettings.objects.select_for_update().get(branch=get_branch())
            if cfg.is_live:
                raise BusinessRuleError("The shop is already live. The opening balance can no longer be changed here.", code="already_live")
            before = {"amount": cfg.prepared_opening_cumulative_sales, "as_of": cfg.opening_balance_as_of}
            cfg.prepared_opening_cumulative_sales = money(ser.validated_data["opening_cumulative_sales"])
            cfg.opening_balance_as_of = ser.validated_data["as_of_date"]
            cfg.opening_balance_note = ser.validated_data["note"].strip()
            cfg.opening_balance_prepared_by = request.user
            cfg.save()
            audit(request.user, "setup.opening_balance_prepared", cfg, summary="Opening cumulative sales balance prepared for approval",
                  reason=cfg.opening_balance_note, before=before,
                  after={"amount": cfg.prepared_opening_cumulative_sales, "as_of": cfg.opening_balance_as_of})
        return Response({"prepared_opening_cumulative_sales": str(cfg.prepared_opening_cumulative_sales),
                         "opening_balance_as_of": cfg.opening_balance_as_of})


class GoLiveSerializer(serializers.Serializer):
    # No default on purpose: the Owner must state the figure being approved.
    opening_cumulative_sales = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=0)
    as_of_date = serializers.DateField()
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")
    confirm = serializers.BooleanField()
    # Zero is accepted only as a deliberate fresh start, never as a stand-in for an unknown history.
    confirm_new_baseline = serializers.BooleanField(required=False, default=False)


class GoLiveView(APIView):
    """Owner confirms the opening figures and switches live selling on. Can only be done once."""

    permission_classes = [IsOwner]

    @extend_schema(request=GoLiveSerializer, responses=SettingsSerializer)
    def post(self, request):
        ser = GoLiveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if not ser.validated_data["confirm"]:
            raise BusinessRuleError("Please tick the confirmation box to start live selling.", code="not_confirmed")
        with transaction.atomic():
            cfg = BusinessSettings.objects.select_for_update().get(branch=get_branch())
            if cfg.is_live:
                raise BusinessRuleError("The shop is already live. Opening figures can no longer be changed here.", code="already_live")
            missing = [s["title"] for s in setup_steps(cfg.branch) if not s["done"]]
            if missing:
                raise BusinessRuleError("Finish the remaining setup steps first.", code="setup_incomplete", details=missing)
            amount = money(ser.validated_data["opening_cumulative_sales"])
            if amount == 0 and not ser.validated_data["confirm_new_baseline"]:
                raise BusinessRuleError(
                    "An opening balance of zero means cumulative sales tracking starts fresh from today. "
                    "Tick the box to confirm this is a new baseline, or enter the verified balance.",
                    code="zero_needs_confirmation", status_code=400,
                )
            cfg.opening_cumulative_sales = amount
            cfg.opening_balance_as_of = ser.validated_data["as_of_date"]
            cfg.opening_balance_note = ser.validated_data["note"].strip() or cfg.opening_balance_note
            cfg.went_live_at = timezone.now()
            cfg.went_live_by = request.user
            cfg.save()
            audit(request.user, "setup.went_live", cfg, summary="Opening balance approved and live selling switched on",
                  reason=cfg.opening_balance_note,
                  after={"opening_cumulative_sales": amount, "as_of": cfg.opening_balance_as_of,
                         "new_baseline": amount == 0, "prepared_figure": cfg.prepared_opening_cumulative_sales,
                         "prepared_by": getattr(cfg.opening_balance_prepared_by, "username", "")})
        return Response(SettingsSerializer(cfg).data)


class AuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuditLog
        fields = ["id", "created_at", "actor_username", "action", "entity_type", "entity_id", "summary", "reason", "before", "after"]


class AuditLogListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = AuditLogSerializer

    def get_queryset(self):
        qs = AuditLog.objects.all()
        params = self.request.query_params
        if params.get("action"):
            qs = qs.filter(action__startswith=params["action"])
        if params.get("user"):
            qs = qs.filter(actor_username__iexact=params["user"])
        if params.get("date_from"):
            qs = qs.filter(created_at__date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(created_at__date__lte=params["date_to"])
        return qs


def opening_stock_state_for(branch) -> dict:
    from inventory.services import opening_stock_state

    return opening_stock_state(branch)
