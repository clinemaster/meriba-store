from drf_spectacular.utils import extend_schema
from rest_framework import generics, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant, IsSignedIn
from core.errors import BusinessRuleError
from core.services import get_branch, get_settings, local_today

from . import services
from .models import BusinessDay, CashierShift


def _figures_json(figures: dict) -> dict:
    out = {k: (str(v) if k not in ("sale_count", "voided_count", "payments") else v) for k, v in figures.items()}
    if "payments" in figures:
        out["payments"] = [{**p, "amount": str(p["amount"])} for p in figures["payments"]]
    return out


class DaySerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = BusinessDay
        fields = [
            "id", "date", "status", "status_label", "opening_cumulative_sales", "gross_sales", "discounts", "voids",
            "refunds", "net_sales", "closing_cumulative_sales", "opened_at", "closed_at",
        ]


class ShiftSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    cashier_name = serializers.CharField(source="cashier.display_name", read_only=True)
    business_date = serializers.DateField(source="business_day.date", read_only=True)
    reviewed_by_name = serializers.CharField(source="reviewed_by.display_name", read_only=True, default="")
    payment_totals = serializers.SerializerMethodField()

    class Meta:
        model = CashierShift
        fields = [
            "id", "business_day", "business_date", "cashier", "cashier_name", "status", "status_label",
            "opening_float", "opened_at", "closed_at", "sales_total", "expected_cash", "counted_cash",
            "cash_variance", "closing_note", "reviewed_by_name", "reviewed_at", "review_note", "payment_totals",
        ]

    def get_payment_totals(self, obj) -> list:
        return [
            {"method": t.payment_method_id, "name": t.payment_method.name, "is_cash": t.payment_method.is_cash,
             "amount": str(t.recorded_amount), "count": t.transaction_count, "is_verified": t.is_verified}
            for t in obj.payment_totals.select_related("payment_method")
        ]


class CurrentDayView(APIView):
    """Everything the home screen and the closing screen need about 'now' for the signed-in user."""

    permission_classes = [IsSignedIn]

    @extend_schema(responses={200: dict})
    def get(self, request):
        branch = get_branch()
        cfg = get_settings(branch)
        day = services.open_day(branch)
        shift = services.open_shift_for(request.user)
        today = local_today()
        body = {
            "is_live": cfg.is_live,
            "today": today,
            "day": DaySerializer(day).data if day else None,
            "shift": ShiftSerializer(shift).data if shift else None,
            "shift_figures": _figures_json(services.shift_figures(shift)) if shift else None,
            "day_needs_closing": bool(day and day.date != today),
            "closed_shift_today": None,
        }
        if not shift:
            done = CashierShift.objects.filter(cashier=request.user, business_day__date=today).exclude(
                status=CashierShift.Status.OPEN).first()
            body["closed_shift_today"] = ShiftSerializer(done).data if done else None
        if not day:
            # Shown on "Start Day": the balance the next day will open with.
            last = BusinessDay.objects.filter(branch=branch, status=BusinessDay.Status.CLOSED).order_by("-date").first()
            body["next_opening_cumulative_sales"] = str(last.closing_cumulative_sales if last else cfg.opening_cumulative_sales)
        if day and request.user.is_back_office:
            body["day_figures"] = _figures_json(services.day_figures(day))
            body["open_shifts"] = ShiftSerializer(day.shifts.filter(status=CashierShift.Status.OPEN), many=True).data
        return Response(body)


class StartDaySerializer(serializers.Serializer):
    opening_float = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0, default=0)


class StartDayView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(request=StartDaySerializer, responses=ShiftSerializer)
    def post(self, request):
        ser = StartDaySerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        shift, created = services.start_day(user=request.user, opening_float=ser.validated_data["opening_float"])
        return Response(ShiftSerializer(shift).data, status=201 if created else 200)


class CloseShiftSerializer(serializers.Serializer):
    counted_cash = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=0)
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


def _shift_for(request, pk) -> CashierShift:
    qs = CashierShift.objects.select_related("business_day", "cashier", "reviewed_by")
    if not request.user.is_back_office:
        qs = qs.filter(cashier=request.user)  # cashiers can only ever reach their own shifts
    shift = qs.filter(pk=pk).first()
    if shift is None:
        raise BusinessRuleError("We could not find that shift.", code="not_found", status_code=404)
    return shift


class ShiftDetailView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(responses={200: dict})
    def get(self, request, pk):
        shift = _shift_for(request, pk)
        body = ShiftSerializer(shift).data
        body["figures"] = _figures_json(services.shift_figures(shift))
        body["day"] = DaySerializer(shift.business_day).data
        return Response(body)


class CloseShiftView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(request=CloseShiftSerializer, responses={200: dict})
    def post(self, request, pk):
        ser = CloseShiftSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        _shift_for(request, pk)
        shift, _ = services.close_shift(
            shift_id=pk, actor=request.user, counted_cash=ser.validated_data["counted_cash"], note=ser.validated_data["note"]
        )
        shift = _shift_for(request, pk)
        body = ShiftSerializer(shift).data
        body["day"] = DaySerializer(shift.business_day).data
        return Response(body)


class ReviewShiftSerializer(serializers.Serializer):
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    verified_methods = serializers.ListField(child=serializers.IntegerField(), required=False, default=list)


class ReviewShiftView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(request=ReviewShiftSerializer, responses=ShiftSerializer)
    def post(self, request, pk):
        ser = ReviewShiftSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        shift = services.review_shift(shift_id=pk, reviewer=request.user, **ser.validated_data)
        return Response(ShiftSerializer(shift).data)


class ShiftListView(generics.ListAPIView):
    permission_classes = [IsOwnerOrAccountant]
    serializer_class = ShiftSerializer

    def get_queryset(self):
        qs = CashierShift.objects.select_related("business_day", "cashier", "reviewed_by").prefetch_related("payment_totals")
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("cashier"):
            qs = qs.filter(cashier_id=params["cashier"])
        if params.get("date_from"):
            qs = qs.filter(business_day__date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(business_day__date__lte=params["date_to"])
        return qs


class DayListView(generics.ListAPIView):
    """Cumulative sales balance history: opening, net sales and closing for every business day."""

    permission_classes = [IsOwnerOrAccountant]
    serializer_class = DaySerializer

    def get_queryset(self):
        qs = BusinessDay.objects.filter(branch=get_branch())
        params = self.request.query_params
        if params.get("date_from"):
            qs = qs.filter(date__gte=params["date_from"])
        if params.get("date_to"):
            qs = qs.filter(date__lte=params["date_to"])
        return qs
