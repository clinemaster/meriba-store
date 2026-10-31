"""Business days, cashier shifts, cash reconciliation and the cumulative sales balance."""
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, get_branch, local_today, money

from .models import BusinessDay, CashierShift, OpeningBalanceChange, ShiftPaymentTotal

ZERO = Decimal("0.00")


def shift_figures(shift: CashierShift) -> dict:
    """Live totals for one shift, worked out from its recorded sales and payments."""
    from finance.models import Expense
    from sales.models import Payment, PaymentMethod, Refund, Sale
    from sales.reconciliation import NOT_RECORDED

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
    by_provider: dict[int, list] = {}
    for row in (Payment.objects.filter(sale__shift=shift, sale__status=Sale.Status.COMPLETED)
                .values("method", "provider", "provider__name").annotate(amount=Sum("amount"), count=Count("id"))
                .order_by("method", "provider__sort_order", "provider")):
        by_provider.setdefault(row["method"], []).append({
            "provider": row["provider"], "name": row["provider__name"] or NOT_RECORDED, "amount": row["amount"], "count": row["count"],
        })
    methods = PaymentMethod.objects.filter(Q(is_active=True) | Q(pk__in=paid.keys()))
    payments = [
        {
            "method": m.pk, "code": m.code, "name": m.name, "is_cash": m.is_cash, "icon": m.icon,
            "amount": paid.get(m.pk, {}).get("amount") or ZERO,
            "count": paid.get(m.pk, {}).get("count") or 0,
            # Sale counts above count a split sale once per method; these lines count payments.
            "providers": by_provider.get(m.pk, []) if (m.requires_provider or any(p["provider"] for p in by_provider.get(m.pk, []))) else [],
        }
        for m in methods
    ]
    cash_sales = sum((p["amount"] for p in payments if p["is_cash"]), ZERO)
    cash_refunds = Refund.objects.filter(shift=shift, method__is_cash=True).aggregate(t=Sum("total"))["t"] or ZERO
    cash_paid_out = Expense.objects.filter(shift=shift, status=Expense.Status.RECORDED).aggregate(t=Sum("amount"))["t"] or ZERO
    return {
        "sale_count": totals["sale_count"],
        "sales_total": totals["sales_total"] or ZERO,
        "voided_count": totals["voided_count"],
        "voided_total": totals["voided_total"] or ZERO,
        "payments": payments,
        "opening_float": shift.opening_float,
        "cash_sales": cash_sales,
        "cash_refunds": cash_refunds,
        "cash_paid_out": cash_paid_out,
        # FR-REC-04: expected cash = float + cash kept from sales − cash refunds − cash paid out of the drawer.
        "expected_cash": shift.opening_float + cash_sales - cash_refunds - cash_paid_out,
    }


def day_figures(day: BusinessDay) -> dict:
    """Net sales for a business day.

    net = gross (every sale recorded that day, at full value)
          − discounts − voids (sales of that day later cancelled; each is in gross once and taken off once)
          − refunds paid out that day (for sales of any day) + Owner-authorised corrections.
    """
    from sales.models import Refund, Sale

    agg = Sale.objects.filter(business_day=day).aggregate(
        gross=Sum("subtotal"),
        discounts=Sum("discount_total"),
        voids=Sum("total", filter=Q(status=Sale.Status.VOIDED)),
        sale_count=Count("id", filter=Q(status=Sale.Status.COMPLETED)),
    )
    gross, discounts, voids = agg["gross"] or ZERO, agg["discounts"] or ZERO, agg["voids"] or ZERO
    refunds = Refund.objects.filter(business_day=day).aggregate(t=Sum("total"))["t"] or ZERO
    net = gross - discounts - voids - refunds + day.adjustments
    return {
        "sale_count": agg["sale_count"], "gross_sales": gross, "discounts": discounts, "voids": voids,
        "refunds": refunds, "adjustments": day.adjustments, "net_sales": net,
        "opening_cumulative_sales": day.opening_cumulative_sales,
        "closing_cumulative_sales": day.opening_cumulative_sales + net,
    }


def open_day(branch=None) -> BusinessDay | None:
    return BusinessDay.objects.filter(branch=branch or get_branch(), status=BusinessDay.Status.OPEN).first()


def open_shift_for(user) -> CashierShift | None:
    return CashierShift.objects.filter(cashier=user, status=CashierShift.Status.OPEN).select_related("business_day").first()


@transaction.atomic
def start_day(*, user, opening_float, opening_cumulative_sales=None, opening_reason="") -> tuple[CashierShift, bool]:
    """Start (or continue) the user's shift, opening the business day if nobody has yet.

    The Owner may give a different opening cumulative sales balance, with a reason, for the day this opens.
    """
    branch = get_branch()
    if opening_cumulative_sales is not None and not user.is_owner:
        raise BusinessRuleError("Only the Owner can change the opening balance.", code="owner_only", status_code=403)
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
        if opening_cumulative_sales is not None and money(opening_cumulative_sales) != opening:
            _change_opening(day, owner=user, amount=opening_cumulative_sales, reason=opening_reason)
    elif opening_cumulative_sales is not None:
        raise BusinessRuleError(
            "The day has already been opened. Change its opening balance on the Daily Closing screen.", code="day_already_open"
        )
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
    from sales.reconciliation import snapshot_for_day

    day.payment_snapshot = snapshot_for_day(day)
    day.save()
    # Keep the day's Daily Sheet as it stands now, as a saved worksheet would be kept.
    from . import sheet

    sheet.freeze(day)
    audit(actor, "day.closed", day, summary=f"Closed business day {day}", after={
        "opening_cumulative_sales": day.opening_cumulative_sales, "net_sales": day.net_sales,
        "closing_cumulative_sales": day.closing_cumulative_sales,
        "payments_collected": day.payment_snapshot["metrics"]["payments_collected"],
        "reconciliation_difference": day.payment_snapshot["metrics"]["reconciliation_difference"],
    })


@transaction.atomic
def close_shift(*, shift_id, actor, counted_cash, note="", payments_reviewed=False) -> tuple[CashierShift, bool]:
    """Record the cash count, freeze the shift, and finalise the day when it was the last open shift."""
    shift = CashierShift.objects.select_for_update(of=("self",)).select_related("cashier").filter(pk=shift_id).first()
    if shift is None or not (actor.is_back_office or shift.cashier_id == actor.pk):
        raise BusinessRuleError("We could not find that shift.", code="not_found", status_code=404)
    if shift.status != CashierShift.Status.OPEN:
        return shift, False  # already closed: a repeated click changes nothing
    if not payments_reviewed:
        raise BusinessRuleError(
            "Check the payment breakdown (cash, each mobile money provider and each bank) and confirm it before closing.",
            code="payments_not_reviewed", status_code=400,
        )

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
    shift.cash_refunds = figures["cash_refunds"]
    shift.cash_paid_out = figures["cash_paid_out"]
    shift.cash_variance = variance
    shift.closing_note = note[:500]
    shift.save()
    ShiftPaymentTotal.objects.bulk_create([
        ShiftPaymentTotal(shift=shift, payment_method_id=p["method"], recorded_amount=p["amount"],
                          transaction_count=p["count"], is_verified=p["is_cash"],
                          provider_breakdown=[{**x, "amount": str(x["amount"])} for x in p["providers"]])
        for p in figures["payments"] if p["amount"] > 0
    ])
    audit(actor, "shift.closed", shift, summary=f"Closed shift of {shift.cashier.display_name} on {day}", reason=note, after={
        "sales_total": shift.sales_total, "expected_cash": shift.expected_cash, "counted_cash": counted,
        "cash_variance": variance, "status": status, "payments_reviewed": True,
        "payments": [{"category": p["code"], "amount": p["amount"], "providers": {x["name"]: x["amount"] for x in p["providers"]}}
                     for p in figures["payments"] if p["amount"] > 0],
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


def _reason(reason: str, message: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise BusinessRuleError(message, code="reason_required", status_code=400)
    return reason[:500]


@transaction.atomic
def change_shift_float(*, shift_id, owner, opening_float, reason) -> CashierShift:
    """Owner only: fix the cash float of a shift that is still open. Expected cash at closing follows it."""
    reason = _reason(reason, "Explain clearly why the float is being changed.")
    opening_float = money(opening_float)
    if opening_float < 0:
        raise BusinessRuleError("The float cannot be less than 0.", code="bad_amount", status_code=400)
    shift = CashierShift.objects.select_for_update().select_related("cashier").filter(pk=shift_id).first()
    if shift is None:
        raise BusinessRuleError("We could not find that shift.", code="not_found", status_code=404)
    if shift.status != CashierShift.Status.OPEN:
        raise BusinessRuleError("This shift is closed. Its float can no longer be changed.", code="shift_closed")
    if opening_float == shift.opening_float:
        raise BusinessRuleError("That is already the float for this shift.", code="no_change", status_code=400)
    before = shift.opening_float
    shift.opening_float = opening_float
    shift.save(update_fields=["opening_float"])
    audit(owner, "shift.float_changed", shift, reason=reason,
          summary=f"Changed the float of {shift.cashier.display_name}'s shift on {shift.business_day} from {before:,.0f} to {opening_float:,.0f}",
          before={"opening_float": before}, after={"opening_float": opening_float})
    return shift


def _change_opening(day: BusinessDay, *, owner, amount, reason) -> OpeningBalanceChange:
    reason = _reason(reason, "Explain clearly why the opening balance is being changed.")
    amount = money(amount)
    if amount < 0:
        raise BusinessRuleError("The opening balance cannot be less than 0.", code="bad_amount", status_code=400)
    if amount == day.opening_cumulative_sales:
        raise BusinessRuleError("That is already the opening balance for this day.", code="no_change", status_code=400)
    before = day.opening_cumulative_sales
    day.opening_cumulative_sales = amount
    day.save(update_fields=["opening_cumulative_sales"])
    change = OpeningBalanceChange.objects.create(
        business_day=day, opening_before=before, opening_after=amount, reason=reason, authorised_by=owner
    )
    audit(owner, "day.opening_changed", day, reason=reason,
          summary=f"Changed the opening cumulative sales balance of {day} from {before:,.0f} to {amount:,.0f}",
          before={"opening_cumulative_sales": before}, after={"opening_cumulative_sales": amount})
    return change


@transaction.atomic
def change_opening_balance(*, day_id, owner, amount, reason) -> OpeningBalanceChange:
    """Owner only: change the open day's opening cumulative sales balance. Kept, with the reason, as a separate record."""
    # Same lock as starting a day or correcting one.
    BusinessSettings.objects.select_for_update().get(branch=get_branch())
    day = BusinessDay.objects.select_for_update().filter(pk=day_id).first()
    if day is None:
        raise BusinessRuleError("We could not find that day.", code="not_found", status_code=404)
    if day.status != BusinessDay.Status.OPEN:
        raise BusinessRuleError(
            "This day is closed. Use Correct… in the balance history to change a closed day.", code="day_closed"
        )
    return _change_opening(day, owner=owner, amount=amount, reason=reason)


def _opening_offset(day: BusinessDay) -> Decimal:
    """How far the Owner has moved this day's opening balance away from the figure it carried forward."""
    return sum((c.opening_after - c.opening_before for c in day.opening_changes.all()), ZERO)


@transaction.atomic
def correct_closed_day(*, day_id, owner, amount, reason, request_key, sale=None) -> tuple["DayCorrection", bool]:
    """Owner-only formal correction of a closed day's net sales.

    Nothing is overwritten silently: the correction row keeps the figures before and after, the reason
    and who authorised it. Every later day's opening and closing balance is then recalculated.
    """
    from .models import DayCorrection

    existing = DayCorrection.objects.filter(request_key=request_key).first()
    if existing:
        return existing, False
    reason = _reason(reason, "Explain clearly why this closed day is being corrected.")
    amount = money(amount)
    if amount == 0:
        raise BusinessRuleError("Enter the amount to add or take off.", code="bad_amount", status_code=400)

    # Same lock as starting a day, so a new day cannot open half-way through the recalculation.
    BusinessSettings.objects.select_for_update().get(branch=get_branch())
    day = BusinessDay.objects.select_for_update().filter(pk=day_id).first()
    if day is None:
        raise BusinessRuleError("We could not find that day.", code="not_found", status_code=404)
    if day.status != BusinessDay.Status.CLOSED:
        raise BusinessRuleError("Only a closed day can be corrected. For an open day, cancel or refund the sale.", code="day_open")
    if sale is not None and sale.business_day_id != day.pk:
        raise BusinessRuleError("That sale does not belong to this day.", code="wrong_day", status_code=400)

    before_net, before_closing = day.net_sales, day.closing_cumulative_sales
    day.adjustments += amount
    day.net_sales += amount
    day.closing_cumulative_sales = day.opening_cumulative_sales + day.net_sales
    day.save(update_fields=["adjustments", "net_sales", "closing_cumulative_sales"])
    correction = DayCorrection.objects.create(
        business_day=day, amount=amount, reason=reason, sale=sale, request_key=request_key, authorised_by=owner,
        net_sales_before=before_net, net_sales_after=day.net_sales,
        closing_before=before_closing, closing_after=day.closing_cumulative_sales,
    )

    # Roll the change forward through every later day so opening always equals the previous closing,
    # plus any change the Owner made to that day's opening balance.
    carried, recalculated = day.closing_cumulative_sales, []
    later = BusinessDay.objects.select_for_update().filter(branch=day.branch, date__gt=day.date).order_by("date")
    for nxt in later:
        old = (nxt.opening_cumulative_sales, nxt.closing_cumulative_sales)
        nxt.opening_cumulative_sales = carried + _opening_offset(nxt)
        if nxt.status == BusinessDay.Status.CLOSED:
            nxt.closing_cumulative_sales = nxt.opening_cumulative_sales + nxt.net_sales
            carried = nxt.closing_cumulative_sales
        nxt.save(update_fields=["opening_cumulative_sales", "closing_cumulative_sales"])
        recalculated.append({"date": str(nxt.date), "opening": [old[0], nxt.opening_cumulative_sales],
                             "closing": [old[1], nxt.closing_cumulative_sales]})
    audit(owner, "day.corrected", day, reason=reason,
          summary=f"Corrected closed day {day} by {amount:,.0f}; {len(recalculated)} later day(s) recalculated",
          before={"net_sales": before_net, "closing_cumulative_sales": before_closing},
          after={"net_sales": day.net_sales, "closing_cumulative_sales": day.closing_cumulative_sales,
                 "sale": getattr(sale, "receipt_number", None), "later_days": recalculated})
    return correction, True
