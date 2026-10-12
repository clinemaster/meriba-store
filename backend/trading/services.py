"""Business days, cashier shifts, cash reconciliation and the cumulative sales balance."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, get_branch, local_today, money

from .models import BusinessDay, CashierShift, ShiftPaymentTotal

ZERO = Decimal("0.00")


def shift_figures(shift: CashierShift) -> dict:
    """Live totals for one shift, worked out from its recorded sales and payments."""
    from sales.models import Payment, PaymentMethod, Sale

    sales = Sale.objects.filter(shift=shift)
    totals = sales.aggregate(
        sale_count=Count("id", filter=Q(status=Sale.Status.COMPLETED)),
        sales_total=Sum("total", filter=Q(status=Sale.Status.COMPLETED)),
        voided_count=Count("id", filter=Q(status=Sale.Status.VOIDED)),
        voided_total=Sum("total", filter=Q(status=Sale.Status.VOIDED)),
    )
    paid = {
        row["method"]: row
        for row in Payment.objects.filter(sale__shift=shift, sale__status=Sale.Status.COMPLETED)
        .values("method")
        .annotate(amount=Sum("amount"), count=Count("sale", distinct=True))
    }
    methods = PaymentMethod.objects.filter(Q(is_active=True) | Q(pk__in=paid.keys()))
    payments = [
        {
            "method": m.pk, "code": m.code, "name": m.name, "is_cash": m.is_cash,
            "amount": paid.get(m.pk, {}).get("amount") or ZERO,
            "count": paid.get(m.pk, {}).get("count") or 0,
        }
        for m in methods
    ]
    cash_sales = sum((p["amount"] for p in payments if p["is_cash"]), ZERO)
    return {
        "sale_count": totals["sale_count"],
        "sales_total": totals["sales_total"] or ZERO,
        "voided_count": totals["voided_count"],
        "voided_total": totals["voided_total"] or ZERO,
        "payments": payments,
        "opening_float": shift.opening_float,
        "cash_sales": cash_sales,
        # Expected cash = float + cash kept from sales (− cash refunds + cash in − cash out, once those exist).
        "expected_cash": shift.opening_float + cash_sales,
    }


def day_figures(day: BusinessDay) -> dict:
    """Net sales for a business day, from its sales. Cancelled sales are shown and then taken off."""
    from sales.models import Sale

    agg = Sale.objects.filter(business_day=day).aggregate(
        gross=Sum("subtotal"),
        discounts=Sum("discount_total"),
        voids=Sum("total", filter=Q(status=Sale.Status.VOIDED)),
        sale_count=Count("id", filter=Q(status=Sale.Status.COMPLETED)),
    )
    gross, discounts, voids = agg["gross"] or ZERO, agg["discounts"] or ZERO, agg["voids"] or ZERO
    refunds = ZERO  # customer returns arrive with the returns workflow
    net = gross - discounts - voids - refunds
    return {
        "sale_count": agg["sale_count"], "gross_sales": gross, "discounts": discounts, "voids": voids,
        "refunds": refunds, "net_sales": net,
        "opening_cumulative_sales": day.opening_cumulative_sales,
        "closing_cumulative_sales": day.opening_cumulative_sales + net,
    }


def open_day(branch=None) -> BusinessDay | None:
    return BusinessDay.objects.filter(branch=branch or get_branch(), status=BusinessDay.Status.OPEN).first()


def open_shift_for(user) -> CashierShift | None:
    return CashierShift.objects.filter(cashier=user, status=CashierShift.Status.OPEN).select_related("business_day").first()


@transaction.atomic
def start_day(*, user, opening_float) -> tuple[CashierShift, bool]:
    """Start (or continue) the user's shift, opening the business day if nobody has yet."""
    branch = get_branch()
    # Locking the settings row makes two people starting the day at once take turns.
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if not cfg.is_live:
        raise BusinessRuleError(
            "The shop has not been set up for selling yet. Ask the Owner to finish the setup.", code="not_live"
        )
    mine = open_shift_for(user)
    if mine:
        return mine, False

    today = local_today()
    day = BusinessDay.objects.select_for_update().filter(branch=branch, status=BusinessDay.Status.OPEN).first()
    if day and day.date != today:
        raise BusinessRuleError(
            f"The day of {day} has not been closed yet. It must be closed before a new day can start.",
            code="previous_day_open",
        )
    if day is None:
        if BusinessDay.objects.filter(branch=branch, date=today).exists():
            raise BusinessRuleError(
                "Today has already been closed. A new day can be started tomorrow.", code="day_already_closed"
            )
        last = BusinessDay.objects.filter(branch=branch, status=BusinessDay.Status.CLOSED).order_by("-date").first()
        if last and last.date > today:
            raise BusinessRuleError(
                "This computer's date is earlier than the last closed day. Please check the date and time.",
                code="clock_behind",
            )
        # Carry forward: the last finalised closing balance becomes today's opening balance.
        # Days with no trading are simply skipped; the balance does not change.
        opening = last.closing_cumulative_sales if last else cfg.opening_cumulative_sales
        day = BusinessDay.objects.create(
            branch=branch, date=today, previous_day=last, opening_cumulative_sales=opening, opened_by=user
        )
        audit(user, "day.opened", day, summary=f"Opened business day {day}",
              after={"opening_cumulative_sales": opening, "carried_from": str(last.date) if last else "go-live value"})
    if CashierShift.objects.filter(business_day=day, cashier=user).exists():
        raise BusinessRuleError("You have already closed your shift for today.", code="shift_already_closed")
    shift = CashierShift.objects.create(business_day=day, cashier=user, opening_float=money(opening_float))
    audit(user, "shift.opened", shift, summary=f"Started shift on {day}", after={"opening_float": shift.opening_float})
    return shift, True


def _finalise_day(day: BusinessDay, actor) -> None:
    figures = day_figures(day)
    day.gross_sales = figures["gross_sales"]
    day.discounts = figures["discounts"]
    day.voids = figures["voids"]
    day.refunds = figures["refunds"]
    day.net_sales = figures["net_sales"]
    day.closing_cumulative_sales = day.opening_cumulative_sales + day.net_sales
    day.status = BusinessDay.Status.CLOSED
    day.closed_by = actor
    day.closed_at = timezone.now()
    day.save()
    audit(actor, "day.closed", day, summary=f"Closed business day {day}", after={
        "opening_cumulative_sales": day.opening_cumulative_sales, "net_sales": day.net_sales,
        "closing_cumulative_sales": day.closing_cumulative_sales,
    })


@transaction.atomic
def close_shift(*, shift_id, actor, counted_cash, note="") -> tuple[CashierShift, bool]:
    """Record the cash count, freeze the shift, and finalise the day when it was the last open shift."""
    shift = CashierShift.objects.select_for_update(of=("self",)).select_related("cashier").filter(pk=shift_id).first()
    if shift is None or not (actor.is_back_office or shift.cashier_id == actor.pk):
        raise BusinessRuleError("We could not find that shift.", code="not_found", status_code=404)
    if shift.status != CashierShift.Status.OPEN:
        return shift, False  # already closed: a repeated click changes nothing

    # Locking the day makes any sale in progress finish first, and blocks new ones.
    day = BusinessDay.objects.select_for_update().get(pk=shift.business_day_id)
    cfg = BusinessSettings.objects.get(branch=day.branch)
    figures = shift_figures(shift)
    counted = money(counted_cash)
    variance = counted - figures["expected_cash"]
    note = (note or "").strip()
    has_non_cash = any(p["amount"] > 0 and not p["is_cash"] for p in figures["payments"])

    if abs(variance) > cfg.cash_variance_tolerance:
        if not note:
            word = "short" if variance < 0 else "over"
            raise BusinessRuleError(
                f"The cash counted is {abs(variance):,.0f} {word}. Please count again, or write a short note "
                "explaining the difference so it can be reviewed.",
                code="variance_needs_note", status_code=400,
                details={"expected_cash": str(figures["expected_cash"]), "cash_variance": str(variance)},
            )
        status = CashierShift.Status.DISCREPANCY
    elif has_non_cash:
        status = CashierShift.Status.PENDING
    else:
        status = CashierShift.Status.BALANCED

    shift.status = status
    shift.closed_at = timezone.now()
    shift.closed_by = actor
    shift.sales_total = figures["sales_total"]
    shift.expected_cash = figures["expected_cash"]
    shift.counted_cash = counted
    shift.cash_variance = variance
    shift.closing_note = note[:500]
    shift.save()
    ShiftPaymentTotal.objects.bulk_create([
        ShiftPaymentTotal(shift=shift, payment_method_id=p["method"], recorded_amount=p["amount"],
                          transaction_count=p["count"], is_verified=p["is_cash"])
        for p in figures["payments"] if p["amount"] > 0
    ])
    audit(actor, "shift.closed", shift, summary=f"Closed shift of {shift.cashier.display_name} on {day}", reason=note, after={
        "sales_total": shift.sales_total, "expected_cash": shift.expected_cash, "counted_cash": counted,
        "cash_variance": variance, "status": status,
    })
    if not day.shifts.filter(status=CashierShift.Status.OPEN).exists():
        _finalise_day(day, actor)
    return shift, True


@transaction.atomic
def review_shift(*, shift_id, reviewer, note="", verified_methods=()) -> CashierShift:
    """Accountant/Owner checks a closed shift: confirms non-cash totals and accepts any cash difference."""
    from sales.models import Payment

    shift = CashierShift.objects.select_for_update(of=("self",)).select_related("cashier", "business_day").filter(pk=shift_id).first()
    if shift is None:
        raise BusinessRuleError("We could not find that shift.", code="not_found", status_code=404)
    if shift.status == CashierShift.Status.OPEN:
        raise BusinessRuleError("This shift is still open. It must be closed before it can be reviewed.", code="shift_open")
    if shift.status == CashierShift.Status.APPROVED:
        return shift
    if shift.cashier_id == reviewer.pk:
        raise BusinessRuleError(
            "You cannot approve your own shift. Another Owner or Accountant must review it.", code="self_review"
        )
    note = (note or "").strip()
    if shift.status == CashierShift.Status.DISCREPANCY and not note:
        raise BusinessRuleError("Write a note explaining how the cash difference was resolved.", code="note_required", status_code=400)

    verified_methods = set(verified_methods)
    newly = shift.payment_totals.filter(is_verified=False, payment_method_id__in=verified_methods)
    Payment.objects.filter(
        sale__shift=shift, method_id__in=newly.values("payment_method_id"), status=Payment.Status.RECORDED
    ).update(status=Payment.Status.VERIFIED)
    newly.update(is_verified=True)
    remaining = list(shift.payment_totals.filter(is_verified=False).values_list("payment_method__name", flat=True))
    if remaining:
        raise BusinessRuleError(
            "Check these payment totals against the phone or bank records and tick them first: " + ", ".join(remaining) + ".",
            code="payments_unverified", status_code=400,
        )
    before = shift.status
    shift.status = CashierShift.Status.APPROVED
    shift.reviewed_by = reviewer
    shift.reviewed_at = timezone.now()
    shift.review_note = note[:500]
    shift.save()
    audit(reviewer, "shift.approved", shift, reason=note,
          summary=f"Approved shift of {shift.cashier.display_name} on {shift.business_day}",
          before={"status": before}, after={"status": shift.status, "cash_variance": shift.cash_variance})
    return shift
