import csv
from decimal import Decimal

from django.db import transaction
from django.db.models import Case, Count, DecimalField, F, IntegerField, OuterRef, Q, Subquery, Value, When
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from accounts.permissions import IsOwnerOrAccountant, IsSignedIn
from core.errors import BusinessRuleError
from core.models import AuditLog
from core.services import audit, get_branch, money
from inventory.models import InventoryMovement, StockBalance

from . import stock_levels, table
from .models import Category, Product, ProductUnit, SoldBy


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


class ProductSaleSerializer(serializers.ModelSerializer):
    """What a cashier may see: no purchase price, no cost, no profit, no thresholds."""

    category_name = serializers.CharField(source="category.name", read_only=True, default="")
    stock_on_hand = serializers.DecimalField(max_digits=14, decimal_places=3, read_only=True)
    stock_status = serializers.SerializerMethodField()
    units = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = [
            "id", "sku", "name", "category", "category_name", "brand", "package_size", "pack_description",
            "base_unit", "volume_ml", "bottles_per_unit", "selling_price", "is_active", "stock_on_hand",
            "stock_status", "units",
        ]

    def get_stock_status(self, obj) -> str:
        return stock_levels.stock_status(getattr(obj, "stock_on_hand", Decimal("0")), obj.reorder_point, obj.critical_point)

    def get_units(self, obj) -> list:
        units = [u for u in obj.units.all() if u.is_active and u.is_verified]
        return ProductUnitSerializer(units, many=True).data


class ProductManageSerializer(ProductSaleSerializer):
    sku = serializers.CharField(max_length=30, required=False, allow_blank=True)

    class Meta(ProductSaleSerializer.Meta):
        fields = ProductSaleSerializer.Meta.fields + ["cost_price", "average_cost", "cost_provisional", "reorder_point",
                                                      "critical_point", "target_stock", "created_at", "updated_at"]
        read_only_fields = ["average_cost", "cost_provisional"]  # worked out by the system from deliveries
        extra_kwargs = {
            **{name: {"min_value": 0} for name in ("selling_price", "cost_price", "reorder_point", "critical_point", "target_stock")},
            "volume_ml": {"min_value": 1, "max_value": 100000},
            "bottles_per_unit": {"min_value": 1, "max_value": 10000},
            "base_unit": {"error_messages": {"invalid_choice": "Choose one of: " + ", ".join(SoldBy.values) + "."}},
        }

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

    def validate_selling_price(self, value):
        return money(value)

    def validate(self, attrs):
        current = self.instance
        price = attrs.get("selling_price", getattr(current, "selling_price", Decimal("0")))
        active = attrs.get("is_active", getattr(current, "is_active", True))
        if active and price <= 0:
            # A product can be kept on record without a price, but it cannot be put on sale.
            raise serializers.ValidationError({"selling_price": [
                "Enter the selling price. A product cannot be on sale without one. "
                "To keep it without a price for now, untick “On sale”."
            ]})

        low = attrs.get("reorder_point", getattr(current, "reorder_point", Decimal("0")))
        critical = attrs.get("critical_point", getattr(current, "critical_point", Decimal("0")))
        if critical > 0 and low <= 0:
            raise serializers.ValidationError({"critical_point": [
                "Set the low-stock warning level first. The critical level must be lower than it."
            ]})
        if critical > 0 and critical >= low:
            raise serializers.ValidationError({"critical_point": [
                f"The critical level must be lower than the low-stock warning level ({_plain(low)})."
            ]})

        sold_by = attrs.get("base_unit", getattr(current, "base_unit", SoldBy.BOTTLE))
        if current and "base_unit" in attrs and attrs["base_unit"] != current.base_unit:
            # Every stock and sales quantity of this product is in its Sold By unit. Changing the unit
            # afterwards would silently change what those quantities mean.
            if InventoryMovement.objects.filter(product=current).exists() or current.units.exists():
                raise serializers.ValidationError({"base_unit": [
                    f"This product already has stock or sales recorded in {current.base_unit.lower()}s, so its unit "
                    "cannot be changed. Add an extra package to sell it another way, or create a new product."
                ]})
        per_unit = attrs.get("bottles_per_unit", getattr(current, "bottles_per_unit", None))
        if sold_by == SoldBy.BOTTLE and per_unit not in (None, 1):
            raise serializers.ValidationError({"bottles_per_unit": ["A product sold by the bottle holds one bottle. Leave this empty."]})
        if sold_by == SoldBy.BOTTLE and "base_unit" in attrs:
            attrs["bottles_per_unit"] = None

        # Keep the size text shown on receipts and screens in step with the volume.
        if "volume_ml" in attrs:
            old_text = f"{current.volume_ml}ml" if current and current.volume_ml else None
            if attrs["volume_ml"]:
                attrs["package_size"] = f"{attrs['volume_ml']}ml"
            elif current and current.package_size == old_text:
                attrs["package_size"] = ""
        return attrs

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


AUDITED_FIELDS = ["name", "sku", "selling_price", "cost_price", "is_active", "base_unit", "volume_ml",
                  "bottles_per_unit", "reorder_point", "critical_point", "target_stock"]
PLAIN = (Decimal,)


def _plain(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return str(value.normalize()) if value != value.to_integral_value() else str(int(value))
    return value


class UnitChangeSerializer(serializers.Serializer):
    factor = serializers.DecimalField(max_digits=12, decimal_places=3, min_value=1, required=False)
    selling_price = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0, required=False)
    is_active = serializers.BooleanField(required=False)


class ProductViewSet(viewsets.ModelViewSet):
    """Products. Everyone signed in can search; only Owner/Accountant can add or change. No deleting."""

    http_method_names = ["get", "post", "patch"]

    def get_permissions(self):
        # Only the plain list and single product are open to cashiers (without cost fields).
        # The table, the details view and every change are back office only.
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
            qs = qs.filter(cond)
        if params.get("category"):
            qs = qs.filter(category_id=params["category"])
        # Back office only: products at or below their reorder point (products with no reorder point set are left out).
        if params.get("low_stock") == "true" and getattr(self.request.user, "is_back_office", False):
            qs = qs.filter(is_active=True, reorder_point__gt=0, stock_on_hand__lte=F("reorder_point")).order_by("stock_on_hand", "name")
        # Back office only: products at the chosen stock levels, worst first (e.g. ?stock_status=ATTENTION).
        wanted = stock_levels.parse_statuses(params.get("stock_status"))
        if wanted and getattr(self.request.user, "is_back_office", False):
            worst_first = Case(*[When(stock_level=s, then=Value(-stock_levels.severity(s))) for s in stock_levels.ORDER],
                               output_field=IntegerField())
            qs = (qs.filter(is_active=True).annotate(stock_level=stock_levels.status_expression())
                  .filter(stock_level__in=wanted).order_by(worst_first, "stock_on_hand", "name"))
        return qs

    @extend_schema(responses={200: dict})
    @action(detail=False, url_path="stock-levels")
    def stock_level_counts(self, request):
        """How many products on sale are at each stock level, for the dashboard. Back office only."""
        counts = dict(self.get_queryset().filter(is_active=True).annotate(stock_level=stock_levels.status_expression())
                      .order_by().values("stock_level").annotate(n=Count("id")).values_list("stock_level", "n"))
        return Response({
            "counts": {s: counts.get(s, 0) for s in stock_levels.ORDER},
            "labels": stock_levels.LABELS,
            "total": sum(counts.values()),
        })

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
            if "selling_price" in changed or "cost_price" in changed:
                action_name = "product.price_changed"
            elif "bottles_per_unit" in changed or "base_unit" in changed:
                action_name = "product.package_changed"
            else:
                action_name = "product.changed"
            audit(self.request.user, action_name, product, summary=f"Changed product '{product}'",
                  before={k: before[k] for k in changed}, after=changed)

    # --- The product table ---------------------------------------------------------------------

    @extend_schema(responses={200: dict})
    @action(detail=False, url_path="table")
    def table(self, request):
        """Stock, sales and gross profit per product for a business day or date range. Back office only."""
        start, end = table.period(request.query_params)
        rows = table.rows_for(table.base_queryset(request.query_params), start, end)
        wanted = stock_levels.parse_statuses(request.query_params.get("stock_status"))
        if wanted:
            rows = [r for r in rows if r["stock_status"] in wanted]
        rows = table.sort_rows(rows, request.query_params.get("ordering", "serial_number"))
        summary = table.totals(rows)

        if request.query_params.get("download") == "csv":
            response = HttpResponse(content_type="text/csv; charset=utf-8")
            response["Content-Disposition"] = f'attachment; filename="meriba_products_{start}_to_{end}.csv"'
            response.write("﻿")
            writer = csv.writer(response)
            writer.writerow(["MERIBA product table", f"{start} to {end}"])
            writer.writerow(["S/No", "Product", "Unit", "Volume (ml)", "Closing Stock", "Purchase Price",
                             "Selling Price", "Total Sales", "Profit", "Stock on Hand", "Notes"])
            for r in rows:
                notes = []
                if r["profit_status"] == "UNAVAILABLE":
                    notes.append("Profit not available: no reliable purchase cost for some sales")
                if r["profit_status"] == "PROVISIONAL" or r["purchase_price_provisional"]:
                    notes.append("Provisional: rests on an assumed purchase cost")
                if not r["is_active"]:
                    notes.append("Not on sale")
                writer.writerow([r["serial_number"] or "", r["name"], r["sold_by"], r["volume_ml"] or "",
                                 _plain(r["closing_stock"]), "" if r["purchase_price"] is None else _plain(r["purchase_price"].quantize(Decimal("0.01"))),
                                 _plain(r["selling_price"]), _plain(r["total_sales"]), "" if r["profit"] is None else _plain(r["profit"]),
                                 _plain(r["stock"]), "; ".join(notes)])
            writer.writerow(["", "TOTAL", "", "", "", "", "", _plain(summary["total_sales"]), _plain(summary["profit"]), "",
                             f"Profit not available for {summary['profit_unavailable_for']} product(s)" if summary["profit_unavailable_for"] else ""])
            audit(request.user, "report.exported", summary=f"Exported the product table {start} to {end}")
            return response

        try:
            size = min(max(int(request.query_params.get("page_size", 25)), 1), 500)
            page = max(int(request.query_params.get("page", 1)), 1)
        except ValueError:
            raise BusinessRuleError("The page number is not valid.", code="bad_page", status_code=400)
        chunk = rows[(page - 1) * size: page * size]
        return Response({
            "date_from": start, "date_to": end, "count": len(rows), "page": page, "page_size": size,
            "pages": max(1, -(-len(rows) // size)),
            "results": [{k: _plain(v) for k, v in row.items()} for row in chunk],
            "totals": {k: _plain(v) for k, v in summary.items()},
            "sold_by_options": SoldBy.values,
        })

    @extend_schema(responses={200: dict})
    @action(detail=True, url_path="details")
    def details(self, request, pk=None):
        """One product in full: package configuration, period figures, stock movements, purchase and price history."""
        from finance.models import GoodsReceiptLine

        product = self.get_object()
        start, end = table.period(request.query_params)
        figures = table.rows_for([product], start, end)[0]
        movements = InventoryMovement.objects.filter(product=product, branch=get_branch()).select_related("user")[:40]
        purchases = GoodsReceiptLine.objects.filter(product=product).select_related("receipt__supplier").order_by("-id")[:25]
        changes = AuditLog.objects.filter(entity_type="Product", entity_id=str(product.pk),
                                          action__in=["product.price_changed", "product.package_changed", "product.unit_added",
                                                      "product.unit_changed", "product.unit_verified"])[:25]
        return Response({
            "product": ProductManageSerializer(product).data,
            "date_from": start, "date_to": end,
            "figures": {k: _plain(v) for k, v in figures.items()},
            "movements": [{"id": m.pk, "date": m.business_date, "created_at": m.created_at, "type": m.get_movement_type_display(),
                           "change": _plain(m.quantity_delta), "balance_after": _plain(m.balance_after),
                           "by": m.user.display_name, "reason": m.reason} for m in movements],
            "purchases": [{"date": line.receipt.business_date, "supplier": line.receipt.supplier.name if line.receipt.supplier else "",
                           "reference": line.receipt.reference, "quantity": _plain(line.quantity), "unit_cost": _plain(line.unit_cost),
                           "average_before": _plain(line.average_cost_before), "average_after": _plain(line.average_cost_after)}
                          for line in purchases],
            "changes": [{"when": c.created_at, "by": c.actor_username, "what": c.summary, "before": c.before, "after": c.after}
                        for c in changes],
        })

    # --- Extra packages (for example a crate of 12 bottles) -------------------------------------

    @extend_schema(request=ProductUnitSerializer, responses=ProductUnitSerializer)
    @action(detail=True, methods=["post"], url_path="units")
    def add_unit(self, request, pk=None):
        product = self.get_object()
        ser = ProductUnitSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        name = ser.validated_data["name"]
        if name == product.base_unit:
            raise BusinessRuleError(f"This product is already sold by the {name.lower()}. Choose a different package.",
                                    code="same_unit", status_code=400)
        if product.units.filter(name=name).exists():
            raise BusinessRuleError(f"This product already has a {name.lower()} package. Change that one instead.",
                                    code="unit_exists", status_code=400)
        unit = ser.save(product=product)
        audit(request.user, "product.unit_added", product,
              summary=f"Added package to '{product}': 1 {unit.name} = {_plain(unit.factor)} {product.base_unit}(s). Waiting for the Owner to verify.",
              after={"unit": unit.name, "factor": unit.factor, "selling_price": unit.selling_price})
        return Response(ProductUnitSerializer(unit).data, status=201)

    @extend_schema(request=UnitChangeSerializer, responses=ProductUnitSerializer)
    @action(detail=True, methods=["patch"], url_path=r"units/(?P<unit_id>\d+)")
    def change_unit(self, request, pk=None, unit_id=None):
        """Change a package. A new conversion figure must be verified again by the Owner before it can be sold.
        Past sales are untouched: each sale line keeps the figure it was sold with."""
        product = self.get_object()
        ser = UnitChangeSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            unit = ProductUnit.objects.select_for_update().filter(pk=unit_id, product=product).first()
            if unit is None:
                raise BusinessRuleError("We could not find that package.", code="not_found", status_code=404)
            before = {"factor": unit.factor, "selling_price": unit.selling_price, "is_active": unit.is_active, "is_verified": unit.is_verified}
            data = ser.validated_data
            if "factor" in data and data["factor"] != unit.factor:
                unit.factor = data["factor"]
                unit.is_verified = False
            if "selling_price" in data:
                unit.selling_price = money(data["selling_price"])
            if "is_active" in data:
                unit.is_active = data["is_active"]
            unit.save()
            after = {"factor": unit.factor, "selling_price": unit.selling_price, "is_active": unit.is_active, "is_verified": unit.is_verified}
            if before != after:
                audit(request.user, "product.unit_changed", product, summary=f"Changed the {unit.name.lower()} package of '{product}'",
                      before=before, after=after)
        return Response(ProductUnitSerializer(unit).data)

    @extend_schema(request=None, responses=ProductUnitSerializer)
    @action(detail=True, methods=["post"], url_path=r"units/(?P<unit_id>\d+)/verify")
    def verify_unit(self, request, pk=None, unit_id=None):
        if not request.user.is_owner:
            self.permission_denied(request)
        unit = ProductUnit.objects.filter(pk=unit_id, product=self.get_object()).first()
        if unit is None:
            raise BusinessRuleError("We could not find that package.", code="not_found", status_code=404)
        unit.is_verified = True
        unit.save(update_fields=["is_verified"])
        audit(request.user, "product.unit_verified", unit.product,
              summary=f"Verified that 1 {unit.name} = {_plain(unit.factor)} {unit.product.base_unit}(s)")
        return Response(ProductUnitSerializer(unit).data)
