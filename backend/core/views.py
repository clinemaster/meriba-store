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
    from inventory.models import InventoryMovement
    from sales.models import PaymentMethod

    cfg = get_settings(branch)
    products = Product.objects.filter(is_active=True)
    return [
        {"key": "products", "title": "Add your products and selling prices",
         "done": products.exists(), "detail": f"{products.count()} active products"},
        {"key": "prices", "title": "Every active product has a selling price",
         "done": products.exists() and not products.filter(selling_price__lte=0).exists(),
         "detail": f"{products.filter(selling_price__lte=0).count()} products without a price"},
        {"key": "payment_methods", "title": "Choose the payment methods you accept",
         "done": PaymentMethod.objects.filter(is_active=True).exists(),
         "detail": ", ".join(PaymentMethod.objects.filter(is_active=True).values_list("name", flat=True))},
        {"key": "opening_stock", "title": "Enter and confirm the opening stock count",
         "done": cfg.opening_stock_confirmed_at is not None,
         "detail": f"{InventoryMovement.objects.filter(branch=branch, movement_type='OPENING').count()} products counted"},
        {"key": "cashier", "title": "Create at least one cashier account",
         "done": User.objects.filter(role=User.Role.CASHIER, is_active=True).exists(), "detail": ""},
    ]


class SetupStatusView(APIView):
    permission_classes = [IsOwner]

    @extend_schema(responses={200: dict})
    def get(self, request):
        branch = get_branch()
        cfg = get_settings(branch)
        steps = setup_steps(branch)
        return Response({
            "is_live": cfg.is_live,
            "went_live_at": cfg.went_live_at,
            "opening_cumulative_sales": str(cfg.opening_cumulative_sales),
            "steps": steps,
            "ready_to_go_live": all(s["done"] for s in steps),
        })


class GoLiveSerializer(serializers.Serializer):
    opening_cumulative_sales = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=0)
    confirm = serializers.BooleanField()


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
            cfg.opening_cumulative_sales = money(ser.validated_data["opening_cumulative_sales"])
            cfg.went_live_at = timezone.now()
            cfg.went_live_by = request.user
            cfg.save()
            audit(request.user, "setup.went_live", cfg, summary="Live selling switched on",
                  after={"opening_cumulative_sales": cfg.opening_cumulative_sales})
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
