"""Payment categories and providers (Owner-configured), the payment transaction list, the reconciliation summary
and the audited provider correction.

Who may do what (checked here on the server, whatever the screen shows):
  Owner       configure categories and providers; everything below
  Accountant  read all categories and providers (on and off), summaries, transactions, exports, history; correct providers
  Cashier     read the categories and providers that are switched on; their own payments and summaries only
"""
from django.db import transaction
from django.db.models import Prefetch, Q
from django.utils.text import slugify
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts.permissions import IsOwner, IsOwnerOrAccountant, IsSignedIn
from core.errors import BusinessRuleError
from core.exports import FORMATS, table_response
from core.models import AuditLog, Branch
from core.pagination import StandardPagination
from core.services import audit, local_today

from . import reconciliation as rec
from .models import Payment, PaymentMethod, PaymentProvider
from .services import correct_payment_provider


def _is_owner(request) -> bool:
    return getattr(request.user, "is_owner", False)


def _back_office(request) -> bool:
    return getattr(request.user, "is_back_office", False)


class PaymentProviderSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    in_use = serializers.SerializerMethodField()

    class Meta:
        model = PaymentProvider
        fields = ["id", "category", "category_name", "code", "name", "description", "is_active", "sort_order",
                  "created_at", "updated_at", "in_use"]
        read_only_fields = ["code", "created_at", "updated_at"]

    def get_in_use(self, obj) -> bool:
        return obj.in_use() if self.context.get("with_usage") else False

    def validate_name(self, value):
        name = " ".join(value.split())
        if len(PaymentProvider.key_for(name)) < 2:
            raise serializers.ValidationError("Enter the provider's name (at least two letters or digits).")
        return name

    def validate(self, attrs):
        category = attrs.get("category") or getattr(self.instance, "category", None)
        if self.instance is not None and "category" in attrs and attrs["category"] != self.instance.category:
            raise serializers.ValidationError({"category": "A provider cannot be moved to another category. Add a new one instead."})
        if category is not None and category.is_cash:
            raise serializers.ValidationError({"category": f"{category.name} is cash in the drawer; it has no providers."})
        name = attrs.get("name")
        if name and category is not None:
            clash = PaymentProvider.objects.filter(category=category, name_key=PaymentProvider.key_for(name))
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError({"name": f"{clash.first().name} already exists in {category.name}."})
        return attrs

    def create(self, validated_data):
        base = slugify(validated_data["name"])[:26] or "provider"
        code, n = base, 1
        while PaymentProvider.objects.filter(category=validated_data["category"], code=code).exists():
            n += 1
            code = f"{base}-{n}"
        validated_data["code"] = code
        if "sort_order" not in validated_data:
            last = PaymentProvider.objects.filter(category=validated_data["category"]).order_by("-sort_order").first()
            validated_data["sort_order"] = (last.sort_order + 1) if last else 1
        return super().create(validated_data)


class PaymentMethodSerializer(serializers.ModelSerializer):
    providers = serializers.SerializerMethodField()
    in_use = serializers.SerializerMethodField()
    code = serializers.SlugField(max_length=20, required=False)

    class Meta:
        model = PaymentMethod
        fields = ["id", "code", "name", "description", "icon", "is_cash", "requires_provider", "reference_label", "is_active",
                  "sort_order", "created_at", "updated_at", "providers", "in_use"]
        read_only_fields = ["created_at", "updated_at"]

    def get_providers(self, obj) -> list:
        return PaymentProviderSerializer(obj.providers.all(), many=True, context=self.context).data

    def get_in_use(self, obj) -> bool:
        return obj.in_use() if self.context.get("with_usage") else False

    def validate_name(self, value):
        name = " ".join(value.split())
        if len(name) < 2:
            raise serializers.ValidationError("Enter the name of the payment category.")
        return name

    def validate(self, attrs):
        if self.instance is not None and "code" in attrs and attrs["code"] != self.instance.code:
            raise serializers.ValidationError({"code": "The code is a permanent identifier and cannot be changed. Change the name instead."})
        is_cash = attrs.get("is_cash", getattr(self.instance, "is_cash", False))
        needs = attrs.get("requires_provider", getattr(self.instance, "requires_provider", False))
        if is_cash and needs:
            raise serializers.ValidationError({"requires_provider": "Cash kept in the drawer cannot require a provider."})
        if self.instance is not None and "is_cash" in attrs and attrs["is_cash"] != self.instance.is_cash and self.instance.in_use():
            raise serializers.ValidationError({"is_cash": "This category has been used, so whether it is drawer cash can no longer change."})
        name = attrs.get("name")
        if name:
            clash = PaymentMethod.objects.filter(name__iexact=name)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError({"name": f"A category called {name} already exists."})
        if self.instance is None:
            code = attrs.get("code") or slugify(attrs.get("name", ""))[:20] or "category"
            if PaymentMethod.objects.filter(code=code).exists():
                raise serializers.ValidationError({"name": "A category with this name (or code) already exists."})
            attrs["code"] = code
        return attrs

    def create(self, validated_data):
        if "sort_order" not in validated_data:
            last = PaymentMethod.objects.order_by("-sort_order").first()
            validated_data["sort_order"] = (last.sort_order + 1) if last else 1
        return super().create(validated_data)


def _config_snapshot(obj) -> dict:
    keys = ["name", "description", "is_active", "sort_order"]
    keys += ["icon", "is_cash", "requires_provider", "reference_label"] if isinstance(obj, PaymentMethod) else ["category_id"]
    return {k: getattr(obj, k) for k in keys}


def _changed_action(kind: str, before: dict, after: dict) -> str:
    changed = {k for k in after if before.get(k) != after.get(k)}
    if changed == {"is_active"}:
        return f"{kind}.switched_{'on' if after['is_active'] else 'off'}"
    return f"{kind}.changed"


class _ReorderSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.IntegerField(), allow_empty=False)


class _ConfigViewSet(viewsets.ModelViewSet):
    """Shared rules: list for everyone signed in; changes for the Owner only; deleting only what was never used."""

    pagination_class = None
    http_method_names = ["get", "post", "patch", "delete"]
    kind = ""

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsSignedIn()]
        if self.action == "history":
            return [IsOwnerOrAccountant()]
        return [IsOwner()]

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "with_usage": _back_office(self.request)}

    def perform_create(self, serializer):
        obj = serializer.save()
        audit(self.request.user, f"{self.kind}.created", obj, summary=f"Added {self.label(obj)}", after=_config_snapshot(obj))

    def perform_update(self, serializer):
        before = _config_snapshot(serializer.instance)
        self.check_switch_off(serializer)
        obj = serializer.save()
        after = _config_snapshot(obj)
        if before != after:
            act = _changed_action(self.kind, before, after)
            word = {"switched_on": "Switched on", "switched_off": "Switched off"}.get(act.split(".")[1], "Changed")
            audit(self.request.user, act, obj, summary=f"{word} {self.label(obj)}", before=before, after=after)

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        if obj.in_use():
            raise BusinessRuleError(
                f"{obj.name} has been used or still has providers, so it is kept for the records. Switch it off instead.",
                code="in_use", status_code=409,
            )
        before = _config_snapshot(obj)
        label, pk = self.label(obj), obj.pk
        obj.delete()
        audit(request.user, f"{self.kind}.deleted", summary=f"Deleted {label} (never used)", before={"id": pk, **before})
        return Response(status=204)

    @extend_schema(request=_ReorderSerializer, responses={200: dict})
    @action(detail=False, methods=["post"])
    @transaction.atomic
    def reorder(self, request):
        ser = _ReorderSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ids = ser.validated_data["ids"]
        objs = {o.pk: o for o in self.reorder_scope(ids)}
        if len(set(ids)) != len(ids) or set(ids) != set(objs):
            raise BusinessRuleError("The list to reorder is not complete. Reload the page and try again.", code="bad_order", status_code=400)
        before = [objs[pk].name for pk in sorted(objs, key=lambda pk: (objs[pk].sort_order, pk))]
        for position, pk in enumerate(ids, start=1):
            if objs[pk].sort_order != position:
                objs[pk].sort_order = position
                objs[pk].save(update_fields=["sort_order", "updated_at"])
        after = [objs[pk].name for pk in ids]
        if before != after:
            audit(request.user, f"{self.kind}.reordered", summary=f"Changed the order of {self.plural}", before={"order": before}, after={"order": after})
        return Response({"ids": ids})

    @extend_schema(responses={200: dict})
    @action(detail=False, methods=["get"])
    def history(self, request):
        """Every change to payment categories and providers, newest first."""
        from core.views import AuditLogSerializer

        qs = AuditLog.objects.filter(Q(action__startswith="payment_method.") | Q(action__startswith="payment_provider."))
        paginator = StandardPagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response(AuditLogSerializer(page, many=True, context={"request": request}).data)


class PaymentMethodViewSet(_ConfigViewSet):
    """Payment categories. Everyone signed in sees the ones switched on (with their providers that are on);
    the Owner and Accountant also see those switched off."""

    serializer_class = PaymentMethodSerializer
    kind, plural = "payment_method", "payment categories"

    def label(self, obj):
        return f"payment category '{obj.name}'"

    def get_queryset(self):
        qs = PaymentMethod.objects.all()
        if not _back_office(self.request):
            return qs.filter(is_active=True).prefetch_related(Prefetch("providers", queryset=PaymentProvider.objects.filter(is_active=True)))
        qs = qs.prefetch_related("providers")
        search = (self.request.query_params.get("search") or "").strip()
        if search:
            qs = qs.filter(Q(name__icontains=search) | Q(description__icontains=search) | Q(providers__name__icontains=search)).distinct()
        if self.request.query_params.get("active") in ("true", "false"):
            qs = qs.filter(is_active=self.request.query_params["active"] == "true")
        return qs

    def reorder_scope(self, ids):
        return PaymentMethod.objects.select_for_update().all()

    def check_switch_off(self, serializer):
        method = serializer.instance
        if method.is_active and serializer.validated_data.get("is_active") is False:
            if not PaymentMethod.objects.filter(is_active=True).exclude(pk=method.pk).exists():
                raise BusinessRuleError("At least one payment method must stay switched on, or nothing could be sold.", code="last_method")


class PaymentProviderViewSet(_ConfigViewSet):
    serializer_class = PaymentProviderSerializer
    kind, plural = "payment_provider", "payment providers"

    def label(self, obj):
        return f"{obj.category.name} provider '{obj.name}'"

    def get_queryset(self):
        qs = PaymentProvider.objects.select_related("category")
        params = self.request.query_params
        if not _back_office(self.request):
            qs = qs.filter(is_active=True, category__is_active=True)
        elif params.get("active") in ("true", "false"):
            qs = qs.filter(is_active=params["active"] == "true")
        if params.get("category"):
            qs = qs.filter(category_id=params["category"])
        if params.get("search"):
            qs = qs.filter(name__icontains=params["search"].strip())
        return qs

    def reorder_scope(self, ids):
        categories = set(PaymentProvider.objects.filter(pk__in=ids).values_list("category_id", flat=True))
        if len(categories) != 1:
            raise BusinessRuleError("Reorder the providers of one category at a time.", code="bad_order", status_code=400)
        return PaymentProvider.objects.select_for_update().filter(category_id=categories.pop())

    def check_switch_off(self, serializer):
        provider = serializer.instance
        if provider.is_active and serializer.validated_data.get("is_active") is False:
            category = provider.category
            others = category.providers.filter(is_active=True).exclude(pk=provider.pk)
            if category.is_active and category.requires_provider and not others.exists():
                raise BusinessRuleError(
                    f"{provider.name} is the last {category.name} provider switched on. Switch on another one first, "
                    f"or switch off {category.name} itself.", code="last_provider",
                )


# ---- Transactions, summary and corrections --------------------------------------------------------------

TRANSACTION_COLUMNS = [
    {"key": "number", "label": "Transaction", "kind": "text"},
    {"key": "receipt_number", "label": "Receipt", "kind": "text"},
    {"key": "date_time", "label": "Date and time", "kind": "text"},
    {"key": "business_date", "label": "Business day", "kind": "date"},
    {"key": "cashier", "label": "Cashier", "kind": "text"},
    {"key": "branch", "label": "Branch", "kind": "text"},
    {"key": "category", "label": "Payment category", "kind": "text"},
    {"key": "provider", "label": "Provider", "kind": "text"},
    {"key": "amount", "label": "Amount (TZS)", "kind": "money"},
    {"key": "reference", "label": "Reference", "kind": "text"},
    {"key": "status", "label": "Status", "kind": "text"},
]
ORDERING = {
    "date": "created_at", "amount": "amount", "receipt": "sale__receipt_number", "category": "method__sort_order",
    "provider": "provider_name", "cashier": "sale__cashier__username", "status": "status", "number": "id",
}


def _local(dt) -> str:
    from zoneinfo import ZoneInfo

    from django.conf import settings

    return dt.astimezone(ZoneInfo(settings.BUSINESS_TIMEZONE)).strftime("%Y-%m-%d %H:%M")


def _payment_rows(qs) -> list[dict]:
    rows = []
    for p in qs.select_related("sale__cashier", "sale__branch", "sale__business_day", "method"):
        rows.append({
            "id": p.pk, "kind": "payment", "number": f"PAY-{p.pk:06d}", "sale": p.sale_id, "receipt_number": p.sale.receipt_number,
            "date_time": _local(p.created_at), "created_at": p.created_at, "business_date": p.sale.business_day.date,
            "cashier": p.sale.cashier.display_name, "branch": p.sale.branch.name,
            "category_id": p.method_id, "category": p.method.name, "category_icon": p.method.icon,
            "provider_id": p.provider_id, "provider": p.provider_name or (rec.NOT_RECORDED if p.method.requires_provider else ""),
            "amount": p.amount, "reference": p.reference, "status_code": p.status, "status": p.get_status_display(),
            "needs_provider": p.method.requires_provider and p.provider_id is None,
        })
    return rows


def _refund_rows(qs) -> list[dict]:
    rows = []
    for r in qs.select_related("sale__branch", "business_day", "method", "created_by", "sale"):
        rows.append({
            "id": r.pk, "kind": "refund", "number": f"REF-{r.pk:06d}", "sale": r.sale_id, "receipt_number": r.sale.receipt_number,
            "date_time": _local(r.created_at), "created_at": r.created_at, "business_date": r.business_day.date,
            "cashier": r.created_by.display_name, "branch": r.sale.branch.name,
            "category_id": r.method_id, "category": r.method.name, "category_icon": r.method.icon,
            "provider_id": r.provider_id, "provider": r.provider_name, "amount": r.total, "reference": r.reference,
            "status_code": "REFUNDED", "status": "Refunded", "needs_provider": False, "reason": r.reason,
        })
    return rows


class PaymentTransactionListView(APIView):
    """Every payment (or refund) matching the filters, one page at a time, with the total of ALL matching rows.

    The same filters as the summary cards, so the total here always equals the card it was opened from.
    `?download=csv` or `?download=xlsx` gives every matching row, not just the page.
    """

    permission_classes = [IsSignedIn]

    @extend_schema(responses={200: dict})
    def get(self, request):
        from django.db.models import Count, Sum

        params = request.query_params
        f = rec.Filters(params, request.user)
        kind = params.get("kind") or "payment"
        if kind not in ("payment", "refund"):
            raise BusinessRuleError("Choose payments or refunds.", code="bad_filter", status_code=400)
        if kind == "payment":
            qs, amount_field = rec.payments(f), "amount"
        else:
            qs, amount_field = rec.refunds(f), "total"
        order = params.get("ordering") or "-date"
        field = ORDERING.get(order.lstrip("-"))
        if field is None:
            raise BusinessRuleError("Choose a valid sort order.", code="bad_filter", status_code=400)
        if kind == "refund":
            field = {"amount": "total", "sale__cashier__username": "created_by__username", "status": "id"}.get(field, field)
        qs = qs.order_by(f"{'-' if order.startswith('-') else ''}{field}", "-id")
        totals = qs.aggregate(amount=Sum(amount_field), count=Count("id"))
        totals = {"amount": totals["amount"] or rec.ZERO, "count": totals["count"]}
        build = _payment_rows if kind == "payment" else _refund_rows

        fmt = params.get("download")
        if fmt:
            if fmt not in FORMATS:
                raise BusinessRuleError("Choose CSV or Excel.", code="bad_filter", status_code=400)
            rows = build(qs)
            name = f"meriba_{'payments' if kind == 'payment' else 'refunds'}_{f.date_from}_to_{f.date_to}"
            audit(request.user, "report.exported", summary=f"Exported {kind}s {f.date_from} to {f.date_to} ({len(rows)} rows, {fmt})",
                  after={k: v for k, v in f.as_dict().items() if v not in (None, "")})
            return table_response(fmt, name, TRANSACTION_COLUMNS, rows, {"amount": totals["amount"]}, title="Refunds" if kind == "refund" else "Payments")

        try:
            size = min(max(int(params.get("page_size") or 25), 1), 200)
            page = max(int(params.get("page") or 1), 1)
        except ValueError:
            raise BusinessRuleError("Choose a valid page.", code="bad_filter", status_code=400)
        pages = max(1, -(-totals["count"] // size))
        page = min(page, pages)
        rows = build(qs[(page - 1) * size: page * size])
        return Response({"kind": kind, "count": totals["count"], "page": page, "page_size": size, "pages": pages,
                         "totals": totals, "filters": f.as_dict(), "results": rows})


class PaymentSummaryView(APIView):
    """Totals for the dashboard cards: sales and money side by side, every category with its providers, the trend."""

    permission_classes = [IsSignedIn]

    @extend_schema(responses={200: dict})
    def get(self, request):
        f = rec.Filters(request.query_params, request.user)
        body = rec.summary(f, request.query_params.get("group") or "day")
        options = {"branches": list(Branch.objects.filter(is_active=True).values("id", "name"))}
        if _back_office(request):
            options["cashiers"] = [{"id": u.pk, "name": u.display_name}
                                   for u in User.objects.filter(Q(sales__isnull=False) | Q(role=User.Role.CASHIER)).distinct().order_by("username")]
            body["unassigned_total"] = rec.unassigned_count()
        body["options"] = options
        body["today"] = local_today()
        return Response(body)


class CorrectProviderSerializer(serializers.Serializer):
    provider = serializers.PrimaryKeyRelatedField(queryset=PaymentProvider.objects.select_related("category"))
    reason = serializers.CharField(max_length=500)


class PaymentProviderCorrectionView(APIView):
    """Owner/Accountant: record which provider carried a payment. Amount and category never change; audited with the reason."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=CorrectProviderSerializer, responses={200: dict})
    def post(self, request, pk):
        ser = CorrectProviderSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        payment = correct_payment_provider(payment_id=pk, actor=request.user, **ser.validated_data)
        return Response(_payment_rows(Payment.objects.filter(pk=payment.pk))[0])
