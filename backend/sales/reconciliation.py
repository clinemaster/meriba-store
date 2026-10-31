"""Payment collections by category and provider, and how they reconcile with sales.

One set of definitions, used by the dashboard, the transaction list, the reports, the exports and the
closing snapshot, so they can never disagree. Dates are business days:

  Gross sales             every sale recorded on the day, at full value (as the daily closing)
  Cancellations           sales of the day later cancelled
  Refunds                 money given back on the day, for sales of any day (decision D6)
  Corrections             the Owner's audited corrections to closed days
  Net sales               gross − discounts − cancellations − refunds + corrections (decision D5)

  Payments collected      money kept from sales of the day that were not cancelled, by category and provider
  Refunds issued          refunds of the day, by category and provider
  Net collections         payments collected − refunds issued
  Outstanding receivables completed sales of the day − payments collected on them. Credit sales are not
                          enabled (FR-PAY-05), so a sale is refused unless fully paid and this stays 0
  Expected collections    net sales − corrections − outstanding receivables
  Reconciliation diff.    net collections − expected collections. 0 when everything is recorded consistently

Corrections are accounting entries with no money behind them, which is why they are taken out of the expected
collections. Every amount is a sum of stored records; nothing is estimated.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.db.models import Count, F, Q, Sum
from django.db.models.functions import TruncMonth, TruncWeek

from core.errors import BusinessRuleError
from core.services import local_today

from .models import Payment, PaymentMethod, PaymentProvider, Refund, Sale

ZERO = Decimal("0.00")
NOT_RECORDED = "Provider not recorded"
COLLECTED = (Payment.Status.RECORDED, Payment.Status.VERIFIED)


class Filters:
    """The filters shared by the summary, the transaction list and the exports, read from the query string."""

    def __init__(self, params, user):
        today = local_today()
        try:
            self.date_from = date.fromisoformat(params["date_from"]) if params.get("date_from") else today
            self.date_to = date.fromisoformat(params["date_to"]) if params.get("date_to") else self.date_from
        except ValueError:
            raise BusinessRuleError("Choose valid dates.", code="bad_date", status_code=400)
        if self.date_from > self.date_to:
            raise BusinessRuleError("The 'from' date must be on or before the 'to' date.", code="bad_date", status_code=400)
        if (self.date_to - self.date_from).days > 3660:
            raise BusinessRuleError("Choose a period of ten years or less.", code="bad_date", status_code=400)

        def number(key):
            value = params.get(key) or ""
            if value in ("", "all"):
                return None
            if value == "none":
                return "none"
            if not str(value).isdigit():
                raise BusinessRuleError(f"Choose a valid {key}.", code="bad_filter", status_code=400)
            return int(value)

        self.category, self.provider, self.branch = number("category"), number("provider"), number("branch")
        # A cashier only ever sees their own payments, whatever the request asks for.
        self.cashier = user.pk if not user.is_back_office else number("cashier")
        self.search = (params.get("search") or "").strip()[:60]
        self.status = params.get("status") or "collected"
        if self.status not in ("collected", "all", *Payment.Status.values):
            raise BusinessRuleError("Choose a valid status.", code="bad_filter", status_code=400)

    @classmethod
    def for_day(cls, day) -> "Filters":
        f = cls.__new__(cls)
        f.__dict__.update({"date_from": day.date, "date_to": day.date, "category": None, "provider": None,
                           "branch": day.branch_id, "cashier": None, "search": "", "status": "collected"})
        return f

    def money_only(self) -> "Filters":
        """The same period, branch and cashier, without the category, provider, search and status filters."""
        f = Filters.__new__(Filters)
        f.__dict__.update({**self.__dict__, "category": None, "provider": None, "search": "", "status": "collected"})
        return f

    def as_dict(self) -> dict:
        return {"date_from": self.date_from, "date_to": self.date_to, "category": self.category, "provider": self.provider,
                "branch": self.branch, "cashier": self.cashier, "status": self.status, "search": self.search}


def _scope_sales(qs, f: Filters, prefix=""):
    qs = qs.filter(**{f"{prefix}business_day__date__range": (f.date_from, f.date_to)})
    if f.branch:
        qs = qs.filter(**{f"{prefix}branch_id": f.branch})
    if f.cashier:
        qs = qs.filter(**{f"{prefix}cashier_id": f.cashier})
    return qs


def _scope_method(qs, f: Filters):
    if f.category:
        qs = qs.filter(method_id=f.category)
    if f.provider == "none":
        qs = qs.filter(provider__isnull=True)
    elif f.provider:
        qs = qs.filter(provider_id=f.provider)
    return qs


def payments(f: Filters):
    """Payment rows matching the filters. The status filter defaults to money actually collected (not reversed)."""
    qs = _scope_method(_scope_sales(Payment.objects.all(), f, "sale__"), f)
    if f.status == "collected":
        qs = qs.filter(status__in=COLLECTED)
    elif f.status != "all":
        qs = qs.filter(status=f.status)
    if f.search:
        qs = qs.filter(Q(sale__receipt_number__icontains=f.search) | Q(reference__icontains=f.search) | Q(provider_name__icontains=f.search))
    return qs


def refunds(f: Filters):
    """Refunds recorded on business days in the period. With a cashier chosen: refunds of that cashier's sales."""
    qs = Refund.objects.filter(business_day__date__range=(f.date_from, f.date_to))
    if f.branch:
        qs = qs.filter(sale__branch_id=f.branch)
    if f.cashier:
        qs = qs.filter(sale__cashier_id=f.cashier)
    qs = _scope_method(qs, f)
    if f.search:
        qs = qs.filter(Q(sale__receipt_number__icontains=f.search) | Q(reference__icontains=f.search) | Q(provider_name__icontains=f.search))
    return qs


def metrics(f: Filters) -> dict:
    """The sales side and the money side of the period, side by side. Ignores category/provider filters by design:
    a sale is counted once, however many methods paid for it."""
    from trading.models import BusinessDay

    sales = _scope_sales(Sale.objects.all(), f).aggregate(
        gross=Sum("subtotal"), discounts=Sum("discount_total"),
        voids=Sum("total", filter=Q(status=Sale.Status.VOIDED)),
        completed=Sum("total", filter=Q(status=Sale.Status.COMPLETED)),
        sale_count=Count("id", filter=Q(status=Sale.Status.COMPLETED)),
        voided_count=Count("id", filter=Q(status=Sale.Status.VOIDED)),
    )
    unfiltered = f.money_only()
    paid = payments(unfiltered).aggregate(t=Sum("amount"), n=Count("id"))
    # Payments of the completed sales of the period: the same population as `completed`, so the difference is credit.
    paid_on_completed = payments(unfiltered).filter(sale__status=Sale.Status.COMPLETED).aggregate(t=Sum("amount"))["t"] or ZERO
    back = refunds(unfiltered).aggregate(t=Sum("total"), n=Count("id"))
    adjustments = ZERO
    if not f.cashier:  # corrections belong to a whole day, not to one cashier
        days = BusinessDay.objects.filter(date__range=(f.date_from, f.date_to))
        if f.branch:
            days = days.filter(branch_id=f.branch)
        adjustments = days.aggregate(t=Sum("adjustments"))["t"] or ZERO

    gross, discounts, voids = sales["gross"] or ZERO, sales["discounts"] or ZERO, sales["voids"] or ZERO
    refunds_total = back["t"] or ZERO
    net_sales = gross - discounts - voids - refunds_total + adjustments
    collected = paid["t"] or ZERO
    outstanding = (sales["completed"] or ZERO) - paid_on_completed
    net_collections = collected - refunds_total
    expected = net_sales - adjustments - outstanding
    return {
        "sale_count": sales["sale_count"], "voided_count": sales["voided_count"], "payment_count": paid["n"], "refund_count": back["n"],
        "gross_sales": gross, "discounts": discounts, "cancellations": voids, "refunds": refunds_total, "adjustments": adjustments,
        "net_sales": net_sales, "payments_collected": collected, "refunds_issued": refunds_total, "net_collections": net_collections,
        "outstanding_receivables": outstanding, "expected_collections": expected,
        "reconciliation_difference": net_collections - expected,
    }


def breakdown(f: Filters) -> list[dict]:
    """Collections and refunds per category, and per provider inside each category.

    Every category total is exactly the sum of its provider lines: payments recorded before providers existed
    sit on their own "Provider not recorded" line rather than being spread over providers by guesswork.
    """
    unfiltered = f.money_only()
    paid = {(r["method"], r["provider"]): {**r, "amount": r["paid"]} for r in payments(unfiltered).values("method", "provider")
            .annotate(paid=Sum("amount"), count=Count("id"), verified=Sum("amount", filter=Q(status=Payment.Status.VERIFIED)))}
    back = {(r["method"], r["provider"]): {**r, "amount": r["given"]} for r in refunds(unfiltered).values("method", "provider")
            .annotate(given=Sum("total"), count=Count("id"))}
    used = {k[0] for k in paid} | {k[0] for k in back}
    categories = PaymentMethod.objects.filter(Q(is_active=True) | Q(pk__in=used)).prefetch_related("providers")

    out = []
    for c in categories:
        providers = []
        provider_ids = {k[1] for k in (*paid, *back) if k[0] == c.pk}
        listed = [p for p in c.providers.all() if p.is_active or p.pk in provider_ids]
        for key, name, active in [(p.pk, p.name, p.is_active) for p in listed] + ([(None, NOT_RECORDED, True)] if None in provider_ids else []):
            if key is None and not c.requires_provider and not listed:
                continue  # e.g. Cash: no provider lines at all
            got, gave = paid.get((c.pk, key), {}), back.get((c.pk, key), {})
            providers.append(_line(key, name, active, got, gave))
        got = [v for k, v in paid.items() if k[0] == c.pk]
        gave = [v for k, v in back.items() if k[0] == c.pk]
        total = _line(c.pk, c.name, c.is_active, {
            "amount": sum((r["amount"] for r in got), ZERO), "count": sum(r["count"] for r in got),
            "verified": sum((r["verified"] or ZERO for r in got), ZERO),
        }, {"amount": sum((r["amount"] for r in gave), ZERO), "count": sum(r["count"] for r in gave)})
        out.append({**total, "code": c.code, "icon": c.icon, "is_cash": c.is_cash, "requires_provider": c.requires_provider,
                    "providers": providers, "unassigned": paid.get((c.pk, None), {}).get("count", 0) if c.requires_provider else 0})
    return out


def _line(key, name, active, got, gave) -> dict:
    amount, refunded = got.get("amount") or ZERO, gave.get("amount") or ZERO
    return {"id": key, "name": name, "is_active": active, "amount": amount, "count": got.get("count") or 0,
            "verified": got.get("verified") or ZERO, "refunds": refunded, "refund_count": gave.get("count") or 0, "net": amount - refunded}


def trend(f: Filters, group: str = "day") -> list[dict]:
    """Payments collected per day, week or month, split by category, for the charts."""
    if group not in ("day", "week", "month"):
        raise BusinessRuleError("Group by day, week or month.", code="bad_filter", status_code=400)
    field = "sale__business_day__date"
    period = {"day": F(field), "week": TruncWeek(field), "month": TruncMonth(field)}[group]
    series: dict = {}
    for r in payments(f).annotate(period=period).values("period", "method").annotate(amount=Sum("amount")):
        when = r["period"].date() if isinstance(r["period"], datetime) else r["period"]
        series.setdefault(when, {})[r["method"]] = r["amount"]
    points, cursor = [], _start_of(f.date_from, group)
    while cursor <= f.date_to:
        values = series.get(cursor, {})
        points.append({"period": cursor, "label": _label(cursor, group), "total": sum(values.values(), ZERO),
                       "by_category": {str(k): v for k, v in values.items()}})
        cursor = _next(cursor, group)
    return points


def _start_of(day: date, group: str) -> date:
    if group == "week":
        return day - timedelta(days=day.weekday())
    if group == "month":
        return day.replace(day=1)
    return day


def _next(day: date, group: str) -> date:
    if group == "week":
        return day + timedelta(days=7)
    if group == "month":
        return (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    return day + timedelta(days=1)


def _label(day: date, group: str) -> str:
    return {"day": f"{day:%d %b}", "week": f"Week of {day:%d %b}", "month": f"{day:%b %Y}"}[group]


def summary(f: Filters, group: str = "day") -> dict:
    cats = breakdown(f)
    m = metrics(f)
    return {
        "filters": f.as_dict(), "metrics": m, "categories": cats, "trend": trend(f, group), "group": group,
        "checks": {
            # Each category equals the sum of its provider lines; the categories together equal the payments collected.
            "providers_match_categories": all(not c["providers"] or sum((p["amount"] for p in c["providers"]), ZERO) == c["amount"] for c in cats),
            "categories_match_total": sum((c["amount"] for c in cats), ZERO) == m["payments_collected"],
            "reconciled": m["reconciliation_difference"] == 0,
        },
    }


def snapshot_for_day(day) -> dict:
    """The reconciliation of one business day, kept on the day when it is closed."""
    f = Filters.for_day(day)
    return jsonable({"metrics": metrics(f), "categories": breakdown(f)})


def jsonable(value):
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def unassigned_count() -> int:
    """Earlier payments in a provider category with no provider recorded: listed for review, never guessed."""
    return Payment.objects.filter(method__requires_provider=True, provider__isnull=True, status__in=COLLECTED).count()
