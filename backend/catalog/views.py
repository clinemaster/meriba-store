from decimal import Decimal

from django.db import transaction
from django.db.models import DecimalField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrAccountant, IsSignedIn
from core.services import audit, get_branch, money
from inventory.models import StockBalance

from .models import Category, Product, ProductUnit


class CategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ["id", "name"]


class ProductUnitSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductUnit
        fields = ["id", "name", "factor", "selling_price", "is_verified", "is_active"]
        read_only_fields = ["is_verified"]
        extra_kwargs = {"selling_price": {"min_value": 0}, "factor": {"min_value": 1}}


def stock_status(quantity: Decimal, reorder_point: Decimal) -> str:
    if quantity <= 0:
        return "OUT_OF_STOCK"
    if reorder_point > 0 and quantity <= reorder_point:
        return "LOW_STOCK"
    return "IN_STOCK"


class ProductSaleSerializer(serializers.ModelSerializer):
    """What a cashier may see: no purchase cost, no thresholds."""

    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    stock_on_hand = serializers.DecimalField(max_digits=14, decimal_places=3, read_only=True)
    stock_status = serializers.SerializerMethodField()
    units = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = [
            "id", "sku", "name", "category", "category_name", "brand", "package_size", "pack_description",
            "base_unit", "barcode", "selling_price", "is_active", "stock_on_hand", "stock_status", "units",
        ]

    def get_stock_status(self, obj) -> str:
        return stock_status(getattr(obj, "stock_on_hand", Decimal("0")), obj.reorder_point)

    def get_units(self, obj) -> list:
        units = [u for u in obj.units.all() if u.is_active and u.is_verified]
        return ProductUnitSerializer(units, many=True).data


class ProductManageSerializer(ProductSaleSerializer):
    sku = serializers.CharField(max_length=30, required=False, allow_blank=True)

    class Meta(ProductSaleSerializer.Meta):
        fields = ProductSaleSerializer.Meta.fields + ["cost_price", "reorder_point", "target_stock", "created_at", "updated_at"]
        extra_kwargs = {name: {"min_value": 0} for name in ("selling_price", "cost_price", "reorder_point", "target_stock")}

    def get_units(self, obj) -> list:
        return ProductUnitSerializer(obj.units.all(), many=True).data

    def validate_name(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Enter the product name.")
        return value

    def validate_sku(self, value):
        value = value.strip().upper()
        qs = Product.objects.filter(sku__iexact=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if value and qs.exists():
            raise serializers.ValidationError("Another product already uses this code.")
        return value

    def validate_barcode(self, value):
        value = value.strip()
        qs = Product.objects.filter(barcode=value)
        if self.instance:
            qs = qs.exclude(pk=self.instance.pk)
        if value and qs.exists():
            raise serializers.ValidationError("Another product already uses this barcode.")
        return value

    def validate_selling_price(self, value):
        return money(value)

    def create(self, validated_data):
        if not validated_data.get("sku"):
            last = Product.objects.order_by("-id").values_list("id", flat=True).first() or 0
            validated_data["sku"] = f"P{last + 1:05d}"
        return super().create(validated_data)


class CategoryViewSet(viewsets.ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    pagination_class = None
    http_method_names = ["get", "post", "patch"]

    def get_permissions(self):
        return [IsSignedIn()] if self.action in ("list", "retrieve") else [IsOwnerOrAccountant()]


AUDITED_FIELDS = ["name", "sku", "selling_price", "cost_price", "is_active", "barcode", "base_unit", "reorder_point", "target_stock"]


class ProductViewSet(viewsets.ModelViewSet):
    """Products. Everyone signed in can search; only Owner/Accountant can add or change. No deleting."""

    http_method_names = ["get", "post", "patch"]

    def get_permissions(self):
        return [IsSignedIn()] if self.action in ("list", "retrieve") else [IsOwnerOrAccountant()]

    def get_serializer_class(self):
        return ProductManageSerializer if getattr(self.request.user, "is_back_office", False) else ProductSaleSerializer

    def get_queryset(self):
        balance = StockBalance.objects.filter(branch=get_branch(), product=OuterRef("pk")).values("quantity")[:1]
        qs = (
            Product.objects.select_related("category")
            .prefetch_related("units")
            .annotate(stock_on_hand=Coalesce(
                Subquery(balance), Value(Decimal("0")), output_field=DecimalField(max_digits=14, decimal_places=3)
            ))
        )
        params = self.request.query_params
        # Cashiers only ever see products that are on sale.
        if not getattr(self.request.user, "is_back_office", False) or params.get("active") == "true":
            qs = qs.filter(is_active=True)
        search = (params.get("search") or "").strip()
        if search:
            cond = Q()
            for word in search.split():
                cond &= (Q(name__icontains=word) | Q(sku__icontains=word) | Q(package_size__icontains=word)
                         | Q(category__name__icontains=word) | Q(brand__icontains=word))
            qs = qs.filter(cond | Q(barcode=search))
        if params.get("category"):
            qs = qs.filter(category_id=params["category"])
        return qs

    @transaction.atomic
    def perform_create(self, serializer):
        product = serializer.save()
        audit(self.request.user, "product.created", product, summary=f"Added product '{product}'",
              after={f: getattr(product, f) for f in AUDITED_FIELDS})

    @transaction.atomic
    def perform_update(self, serializer):
        before = {f: getattr(serializer.instance, f) for f in AUDITED_FIELDS}
        product = serializer.save()
        after = {f: getattr(product, f) for f in AUDITED_FIELDS}
        changed = {k: v for k, v in after.items() if str(before[k]) != str(v)}
        if changed:
            action_name = "product.price_changed" if "selling_price" in changed or "cost_price" in changed else "product.changed"
            audit(self.request.user, action_name, product, summary=f"Changed product '{product}'",
                  before={k: before[k] for k in changed}, after=changed)

    @extend_schema(request=ProductUnitSerializer, responses=ProductUnitSerializer)
    @action(detail=True, methods=["post"], url_path="units")
    def add_unit(self, request, pk=None):
        product = self.get_object()
        ser = ProductUnitSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        unit = ser.save(product=product)
        audit(request.user, "product.unit_added", product, summary=f"Added unit '{unit.name}' x{unit.factor} to '{product}'")
        return Response(ProductUnitSerializer(unit).data, status=201)

    @extend_schema(request=None, responses=ProductUnitSerializer)
    @action(detail=True, methods=["post"], url_path=r"units/(?P<unit_id>\d+)/verify")
    def verify_unit(self, request, pk=None, unit_id=None):
        if not request.user.is_owner:
            self.permission_denied(request)
        unit = ProductUnit.objects.get(pk=unit_id, product=self.get_object())
        unit.is_verified = True
        unit.save(update_fields=["is_verified"])
        audit(request.user, "product.unit_verified", unit.product,
              summary=f"Verified that 1 {unit.name} = {unit.factor} {unit.product.base_unit}")
        return Response(ProductUnitSerializer(unit).data)
