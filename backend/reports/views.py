"""Reports. Every figure is worked out from the stored transactions with the same rules the
closing uses, so a report always reconciles to the underlying records. Back office only."""
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.db.models.functions import TruncMonth
from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant
from catalog.models import Product
from catalog.stock_levels import IN_STOCK, LABELS, stock_status
from core.errors import BusinessRuleError
from core.exports import FORMATS, table_response
from core.services import audit, get_branch, local_today
from finance.models import Expense, GoodsReceipt
from inventory.models import InventoryMovement, StockAdjustment, StockAdjustmentLine, StockBalance
from sales import reconciliation as rec
from sales.models import Payment, PaymentMethod, Refund, RefundItem, Sale, SaleItem
from trading.models import BusinessDay, CashierShift
from trading.services import day_figures

ZERO = Decimal("0")
M, Q3, T, D = "money", "quantity", "text", "date"  # column kinds, used by the screen for formatting


def col(key, label, kind=T):
    return {"key": key, "label": label, "kind": kind}


def _range(params) -> tuple[date, date]:
    today = local_today()
    try:
        start = date.fromisoformat(params["date_from"]) if params.get("date_from") else today.replace(day=1)
        end = date.fromisoformat(params["date_to"]) if params.get("date_to") else today
    except ValueError:
        raise BusinessRuleError("Choose valid dates.", code="bad_date", status_code=400)
    if start > end:
        raise BusinessRuleError("The 'from' date must be on or before the 'to' date.", code="bad_date", status_code=400)
    return start, end


def daily_sales(params):
    """One row per business day. Uses exactly the figures the daily closing stores."""
    start, end = _range(params)
    rows = []
    for day in BusinessDay.objects.filter(branch=get_branch(), date__range=(start, end)).order_by("date"):
        f = day_figures(day)
        rows.append({
            "date": day.date, "status": day.get_status_display(), "sales": f["sale_count"], "gross_sales": f["gross_sales"],
            "voids": f["voids"], "refunds": f["refunds"], "adjustments": f["adjustments"], "net_sales": f["net_sales"],
            "opening": day.opening_cumulative_sales, "closing": f["closing_cumulative_sales"],
        })
    cols = [col("date", "Business day", D), col("status", "Status"), col("sales", "Sales", Q3), col("gross_sales", "Gross sales", M),
            col("voids", "Cancelled", M), col("refunds", "Refunds", M), col("adjustments", "Corrections", M),
            col("net_sales", "Net sales", M), col("opening", "Opening cumulative", M), col("closing", "Closing cumulative", M)]
    return cols, rows, ["sales", "gross_sales", "voids", "refunds", "adjustments", "net_sales"]


def sales_by_product(params):
    start, end = _range(params)
    sold = (SaleItem.objects.filter(sale__status=Sale.Status.COMPLETED, sale__business_day__date__range=(start, end))
            .values("product", "product__name", "product__package_size", "product__sku")
            .annotate(quantity=Sum("quantity_base"), value=Sum("line_total"), cost=Sum("cost_total"),
                      no_cost=Count("id", filter=Q(cost_total__isnull=True))).order_by("-value"))
    returned = {r["sale_item__product"]: r for r in RefundItem.objects.filter(refund__business_day__date__range=(start, end))
                .values("sale_item__product").annotate(quantity=Sum("quantity_base"), value=Sum("amount"), cost=Sum("cost_returned"),
                                                       no_cost=Count("id", filter=Q(cost_returned__isnull=True)))}
    nothing = {"quantity": ZERO, "value": ZERO, "cost": ZERO, "no_cost": 0}

    def line(code, name, s, back):
        net = (s["value"] or ZERO) - (back["value"] or ZERO)
        # Gross profit = net sales − cost of goods sold (cost frozen at the time of each sale).
        # Left empty, not guessed, where a sale had no reliable purchase cost.
        known = not s["no_cost"] and not back["no_cost"]
        cost = (s["cost"] or ZERO) - (back["cost"] or ZERO) if known else None
        return {"code": code, "product": name, "quantity": s["quantity"], "value": s["value"],
                "refunded_quantity": back["quantity"], "refunded_value": back["value"], "net_value": net,
                "cost_of_goods": cost, "gross_profit": None if cost is None else net - cost}

    rows = [line(s["product__sku"], f"{s['product__name']} {s['product__package_size']}".strip(), s, returned.pop(s["product"], nothing))
            for s in sold]
    for pk, back in returned.items():  # refunded in this period but sold in an earlier one
        p = Product.objects.get(pk=pk)
        rows.append(line(p.sku, str(p), nothing, back))
    cols = [col("code", "Code"), col("product", "Product"), col("quantity", "Quantity sold", Q3), col("value", "Sales value", M),
            col("refunded_quantity", "Quantity refunded", Q3), col("refunded_value", "Refunds", M), col("net_value", "Net value", M),
            col("cost_of_goods", "Cost of goods sold", M), col("gross_profit", "Gross profit", M)]
    return cols, rows, ["quantity", "value", "refunded_quantity", "refunded_value", "net_value", "cost_of_goods", "gross_profit"]


def sales_by_cashier(params):
    start, end = _range(params)
    rows = [
        {"cashier": r["cashier__full_name"] or r["cashier__username"], "sales": r["sales"], "value": r["value"] or ZERO,
         "cancelled": r["cancelled"], "cancelled_value": r["cancelled_value"] or ZERO}
        for r in Sale.objects.filter(business_day__date__range=(start, end))
        .values("cashier", "cashier__full_name", "cashier__username")
        .annotate(sales=Count("id", filter=Q(status="COMPLETED")), value=Sum("total", filter=Q(status="COMPLETED")),
                  cancelled=Count("id", filter=Q(status="VOIDED")), cancelled_value=Sum("total", filter=Q(status="VOIDED")))
        .order_by("-value")
    ]
    cols = [col("cashier", "Cashier"), col("sales", "Sales", Q3), col("value", "Sales value", M),
            col("cancelled", "Cancelled sales", Q3), col("cancelled_value", "Cancelled value", M)]
    return cols, rows, ["sales", "value", "cancelled", "cancelled_value"]


def payment_summary(params):
    start, end = _range(params)
    paid = {r["method__name"]: r for r in Payment.objects.filter(sale__status=Sale.Status.COMPLETED, sale__business_day__date__range=(start, end))
            .values("method__name").annotate(count=Count("sale", distinct=True), received=Sum("amount"),
                                             verified=Sum("amount", filter=Q(status="VERIFIED")))}
    refunded = {r["method__name"]: r["amount"] for r in Refund.objects.filter(business_day__date__range=(start, end))
                .values("method__name").annotate(amount=Sum("total"))}
    rows = []
    for name in sorted(set(paid) | set(refunded)):
        p = paid.get(name, {"count": 0, "received": ZERO, "verified": ZERO})
        back = refunded.get(name, ZERO)
        rows.append({"method": name, "sales": p["count"], "received": p["received"] or ZERO, "refunded": back,
                     "net": (p["received"] or ZERO) - back, "verified": p["verified"] or ZERO})
    cols = [col("method", "Payment method"), col("sales", "Sales", Q3), col("received", "Received", M), col("refunded", "Refunded", M),
            col("net", "Net received", M), col("verified", "Of which checked", M)]
    return cols, rows, ["sales", "received", "refunded", "net", "verified"]


def _stock_rows(only_low=False):
    balances = dict(StockBalance.objects.filter(branch=get_branch()).values_list("product", "quantity"))
    rows = []
    for p in Product.objects.filter(is_active=True).order_by("name", "package_size"):
        qty = balances.get(p.pk, ZERO)
        status = stock_status(qty, p.reorder_point, p.critical_point)
        if only_low and status == IN_STOCK:
            continue
        rows.append({
            "code": p.sku, "product": str(p), "unit": p.base_unit, "quantity": qty, "reorder_point": p.reorder_point,
            "critical_point": p.critical_point, "target_stock": p.target_stock,
            "status": LABELS[status],
            "suggested_order": max(p.target_stock - qty, ZERO),  # FR-LOW-04: never negative
            # Valued at the weighted-average cost of what is in stock, not at the latest purchase price.
            "cost_price": p.cost_price, "stock_value": None if p.cost_price is None else qty * p.cost_price,
        })
    return rows


def stock_on_hand(params):
    rows = _stock_rows()
    cols = [col("code", "Code"), col("product", "Product"), col("unit", "Counted by"), col("quantity", "In stock", Q3),
            col("status", "Status"), col("cost_price", "Purchase Price (average)", M), col("stock_value", "Value at cost", M)]
    return cols, rows, ["stock_value"]


def low_stock(params):
    rows = _stock_rows(only_low=True)
    cols = [col("code", "Code"), col("product", "Product"), col("unit", "Counted by"), col("quantity", "In stock", Q3),
            col("reorder_point", "Low-stock level", Q3), col("critical_point", "Critical level", Q3), col("target_stock", "Target", Q3),
            col("suggested_order", "Suggested order", Q3), col("status", "Status")]
    return cols, rows, []


def stock_daily(params):
    """FR-STK-16: per product, opening + received − sold + returned ± adjusted = closing, for the chosen dates."""
    start, end = _range(params)
    ledger = InventoryMovement.objects.filter(branch=get_branch())
    opening = dict(ledger.filter(business_date__lt=start).values("product").annotate(q=Sum("quantity_delta")).values_list("product", "q"))
    T_ = InventoryMovement.Type
    moves = {r["product"]: r for r in ledger.filter(business_date__range=(start, end)).values("product").annotate(
        received=Sum("quantity_delta", filter=Q(movement_type=T_.RECEIPT)),
        sold=Sum("quantity_delta", filter=Q(movement_type__in=[T_.SALE, T_.VOID])),
        returned=Sum("quantity_delta", filter=Q(movement_type=T_.RETURN)),
        adjusted=Sum("quantity_delta", filter=Q(movement_type__in=[T_.ADJUSTMENT, T_.OPENING])),
    )}
    balances = dict(StockBalance.objects.filter(branch=get_branch()).values_list("product", "quantity"))
    after = dict(ledger.filter(business_date__gt=end).values("product").annotate(q=Sum("quantity_delta")).values_list("product", "q"))
    rows = []
    for p in Product.objects.filter(pk__in=set(opening) | set(moves)).order_by("name", "package_size"):
        m = moves.get(p.pk, {})
        o = opening.get(p.pk, ZERO)
        received, sold = m.get("received") or ZERO, -(m.get("sold") or ZERO)
        returned, adjusted = m.get("returned") or ZERO, m.get("adjusted") or ZERO
        closing = o + received - sold + returned + adjusted
        # Cross-check against the live balance: closing + later movements must equal stock on hand now.
        variance = (balances.get(p.pk, ZERO) - (after.get(p.pk) or ZERO)) - closing
        rows.append({"code": p.sku, "product": str(p), "opening": o, "received": received, "sold": sold, "returned": returned,
                     "adjusted": adjusted, "closing": closing, "variance": variance})
    cols = [col("code", "Code"), col("product", "Product"), col("opening", "Opening", Q3), col("received", "Received", Q3),
            col("sold", "Sold", Q3), col("returned", "Returned", Q3), col("adjusted", "Counts / adjustments", Q3),
            col("closing", "Closing", Q3), col("variance", "Ledger check", Q3)]
    return cols, rows, []


def _damage_lines(params, include_reversed=False):
    start, end = _range(params)
    lines = StockAdjustmentLine.objects.filter(
        adjustment__branch=get_branch(), adjustment__kind=StockAdjustment.Kind.DAMAGE,
        adjustment__business_date__range=(start, end), damaged_quantity__isnull=False,
    )
    if not include_reversed:
        lines = lines.filter(adjustment__reversal__isnull=True)
    return start, end, lines


def damage_daily(params):
    """One row per business day; damage is never included in sales or expense figures."""
    _, _, lines = _damage_lines(params)
    rows = [{
        "date": row["adjustment__business_date"], "products": row["products"],
        "damaged_quantity": row["damaged_quantity"], "damage_value": row["damage_value"] or ZERO,
        "inventory_cost_value": row["inventory_cost_value"],
    } for row in lines.values("adjustment__business_date").annotate(
        products=Count("product", distinct=True), damaged_quantity=Sum("damaged_quantity"),
        damage_value=Sum("damage_value"), inventory_cost_value=Sum("inventory_cost_damage_value"),
    ).order_by("adjustment__business_date")]
    cols = [col("date", "Business day", D), col("products", "Products", Q3),
            col("damaged_quantity", "Damaged quantity", Q3), col("damage_value", "Damage at selling price", M),
            col("inventory_cost_value", "Inventory cost of damage", M)]
    return cols, rows, ["products", "damaged_quantity", "damage_value", "inventory_cost_value"]


def damage_monthly(params):
    """Monthly damage totals based on the business date stored with each confirmed adjustment."""
    _, _, lines = _damage_lines(params)
    rows = [{
        "month": row["month"], "products": row["products"], "damaged_quantity": row["damaged_quantity"],
        "damage_value": row["damage_value"] or ZERO, "inventory_cost_value": row["inventory_cost_value"],
    } for row in lines.annotate(month=TruncMonth("adjustment__business_date")).values("month").annotate(
        products=Count("product", distinct=True), damaged_quantity=Sum("damaged_quantity"),
        damage_value=Sum("damage_value"), inventory_cost_value=Sum("inventory_cost_damage_value"),
    ).order_by("month")]
    cols = [col("month", "Month", D), col("products", "Products", Q3),
            col("damaged_quantity", "Damaged quantity", Q3), col("damage_value", "Damage at selling price", M),
            col("inventory_cost_value", "Inventory cost of damage", M)]
    return cols, rows, ["products", "damaged_quantity", "damage_value", "inventory_cost_value"]


def damage_by_product(params):
    _, _, lines = _damage_lines(params)
    rows = [{
        "product": row["product__name"] + (f" {row['product__package_size']}" if row["product__package_size"] else ""),
        "records": row["records"], "damaged_quantity": row["damaged_quantity"],
        "damage_value": row["damage_value"] or ZERO, "inventory_cost_value": row["inventory_cost_value"],
    } for row in lines.values("product__name", "product__package_size").annotate(
        records=Count("adjustment", distinct=True), damaged_quantity=Sum("damaged_quantity"),
        damage_value=Sum("damage_value"), inventory_cost_value=Sum("inventory_cost_damage_value"),
    ).order_by("-damage_value", "product__name", "product__package_size")]
    cols = [col("product", "Product"), col("records", "Damage records", Q3),
            col("damaged_quantity", "Damaged quantity", Q3), col("damage_value", "Damage at selling price", M),
            col("inventory_cost_value", "Inventory cost of damage", M)]
    return cols, rows, ["records", "damaged_quantity", "damage_value", "inventory_cost_value"]


def damage_by_branch(params):
    _, _, lines = _damage_lines(params)
    rows = [{
        "branch": row["adjustment__branch__name"], "products": row["products"],
        "damaged_quantity": row["damaged_quantity"], "damage_value": row["damage_value"] or ZERO,
        "inventory_cost_value": row["inventory_cost_value"],
    } for row in lines.values("adjustment__branch__name").annotate(
        products=Count("product", distinct=True), damaged_quantity=Sum("damaged_quantity"),
        damage_value=Sum("damage_value"), inventory_cost_value=Sum("inventory_cost_damage_value"),
    ).order_by("adjustment__branch__name")]
    cols = [col("branch", "Branch"), col("products", "Products", Q3),
            col("damaged_quantity", "Damaged quantity", Q3), col("damage_value", "Damage at selling price", M),
            col("inventory_cost_value", "Inventory cost of damage", M)]
    return cols, rows, ["products", "damaged_quantity", "damage_value", "inventory_cost_value"]


def damage_register(params):
    _, _, lines = _damage_lines(params, include_reversed=True)
    rows = []
    for line in lines.select_related("product", "adjustment__branch", "adjustment__created_by", "adjustment__reversal", "movement"):
        adjustment = line.adjustment
        rows.append({
            "date": adjustment.business_date, "reference": f"DR-{adjustment.pk:06d}", "product": str(line.product),
            "branch": adjustment.branch.name, "stock_before": line.quantity_before,
            "damaged_quantity": line.damaged_quantity, "stock_after": line.quantity_counted,
            "selling_price": line.selling_price_at_damage, "damage_value": line.damage_value,
            "average_cost": line.average_cost_at_damage, "inventory_cost_value": line.inventory_cost_damage_value,
            "reason": adjustment.reason, "remarks": adjustment.remarks, "evidence": adjustment.evidence_reference,
            "recorded_by": adjustment.created_by.display_name,
            "status": "Reversed" if hasattr(adjustment, "reversal") else "Confirmed",
            "movement": line.movement_id,
        })
    cols = [col("date", "Business day", D), col("reference", "Reference"), col("product", "Product"),
            col("branch", "Branch"), col("stock_before", "Previous stock", Q3), col("damaged_quantity", "Damaged quantity", Q3),
            col("stock_after", "Remaining stock", Q3), col("selling_price", "Selling price", M),
            col("damage_value", "Damage at selling price", M), col("average_cost", "Average unit cost", M),
            col("inventory_cost_value", "Inventory cost of damage", M), col("reason", "Reason"),
            col("remarks", "Remarks"), col("evidence", "Evidence"), col("recorded_by", "Recorded by"),
            col("status", "Status"), col("movement", "Movement ID", Q3)]
    return cols, rows, []


def purchases(params):
    start, end = _range(params)
    rows = [{"date": r.business_date, "supplier": r.supplier.name if r.supplier else "", "reference": r.reference,
             "products": r.n, "total_cost": r.total_cost, "received_by": r.received_by.display_name, "note": r.note}
            for r in GoodsReceipt.objects.filter(branch=get_branch(), business_date__range=(start, end))
            .select_related("supplier", "received_by").annotate(n=Count("lines")).order_by("business_date", "id")]
    cols = [col("date", "Date", D), col("supplier", "Supplier"), col("reference", "Invoice / delivery note"),
            col("products", "Products", Q3), col("total_cost", "Total cost", M), col("received_by", "Received by"), col("note", "Note")]
    return cols, rows, ["total_cost"]


def expenses(params):
    start, end = _range(params)
    rows = [{"date": e.business_date, "category": e.category, "description": e.description, "method": e.method.name,
             "from_drawer": e.shift.cashier.display_name if e.shift else "", "amount": e.amount, "recorded_by": e.recorded_by.display_name}
            for e in Expense.objects.filter(branch=get_branch(), business_date__range=(start, end), status=Expense.Status.RECORDED)
            .select_related("method", "recorded_by", "shift__cashier").order_by("business_date", "id")]
    cols = [col("date", "Date", D), col("category", "Category"), col("description", "Description"), col("method", "Paid by"),
            col("from_drawer", "From drawer of"), col("amount", "Amount", M), col("recorded_by", "Recorded by")]
    return cols, rows, ["amount"]


def closings(params):
    start, end = _range(params)
    rows = [{"date": s.business_day.date, "cashier": s.cashier.display_name, "status": s.get_status_display(),
             "sales": s.sales_total, "float": s.opening_float, "cash_refunds": s.cash_refunds, "cash_paid_out": s.cash_paid_out,
             "expected": s.expected_cash, "counted": s.counted_cash, "variance": s.cash_variance,
             "reviewed_by": s.reviewed_by.display_name if s.reviewed_by else ""}
            for s in CashierShift.objects.filter(business_day__date__range=(start, end)).exclude(status=CashierShift.Status.OPEN)
            .select_related("business_day", "cashier", "reviewed_by").order_by("business_day__date", "id")]
    cols = [col("date", "Business day", D), col("cashier", "Cashier"), col("status", "Status"), col("sales", "Sales", M),
            col("float", "Float", M), col("cash_refunds", "Cash refunds", M), col("cash_paid_out", "Cash paid out", M),
            col("expected", "Cash expected", M), col("counted", "Cash counted", M), col("variance", "Difference", M),
            col("reviewed_by", "Reviewed by")]
    return cols, rows, ["sales", "variance"]


def financial_summary(params):
    """Sales, purchases and expenses side by side. Deliberately not called profit: purchase costs are incomplete."""
    start, end = _range(params)
    _, sales_rows, _ = daily_sales(params)
    net = sum((r["net_sales"] for r in sales_rows), ZERO)
    bought = GoodsReceipt.objects.filter(branch=get_branch(), business_date__range=(start, end))
    bought_total = bought.aggregate(t=Sum("total_cost"))["t"] or ZERO
    uncosted = bought.filter(total_cost__isnull=True).count()
    spent = Expense.objects.filter(branch=get_branch(), business_date__range=(start, end), status="RECORDED").aggregate(t=Sum("amount"))["t"] or ZERO
    rows = [
        {"item": "Net sales", "amount": net, "note": f"{len(sales_rows)} business day(s)"},
        {"item": "Stock purchases (deliveries with a cost)", "amount": bought_total,
         "note": f"{uncosted} delivery(ies) had no cost recorded" if uncosted else ""},
        {"item": "Expenses", "amount": spent, "note": ""},
        {"item": "Net sales less purchases and expenses", "amount": net - bought_total - spent,
         "note": "Not a profit figure: it ignores stock still on the shelf"},
    ]
    return [col("item", "Item"), col("amount", "Amount", M), col("note", "Note")], rows, []


# ---- Payment analysis ------------------------------------------------------------------------------------
# Built on sales/reconciliation.py, the same definitions as the Payments dashboard and the closing snapshot.

class _BackOffice:
    pk = None
    is_back_office = True


def _filters(params, start, end) -> "rec.Filters":
    return rec.Filters({"date_from": start.isoformat(), "date_to": end.isoformat(), "cashier": params.get("cashier"),
                        "branch": params.get("branch")}, _BackOffice())


def _categories(start, end):
    used = Payment.objects.filter(sale__business_day__date__range=(start, end)).values("method")
    refunded = Refund.objects.filter(business_day__date__range=(start, end)).values("method")
    return list(PaymentMethod.objects.filter(Q(is_active=True) | Q(pk__in=used) | Q(pk__in=refunded)))


def _reconciliation(params, group):
    start, end = _range(params)
    cats = _categories(start, end)
    rows, cursor = [], rec._start_of(start, group)
    while cursor <= end:
        nxt = rec._next(cursor, group)
        f = _filters(params, max(cursor, start), min(nxt - timedelta(days=1), end))
        m = rec.metrics(f)
        has_day = BusinessDay.objects.filter(branch=get_branch(), date__range=(f.date_from, f.date_to)).exists()
        if has_day or m["sale_count"] or m["refund_count"] or m["voided_count"]:
            by_cat = {c["id"]: c["amount"] for c in rec.breakdown(f)}
            rows.append({
                "period": rec._label(cursor, group) if group != "day" else cursor, "sales": m["sale_count"],
                "gross_sales": m["gross_sales"], "cancellations": m["cancellations"], "refunds": m["refunds"],
                "adjustments": m["adjustments"], "net_sales": m["net_sales"],
                **{f"cat_{c.pk}": by_cat.get(c.pk, ZERO) for c in cats},
                "payments_collected": m["payments_collected"], "refunds_issued": m["refunds_issued"],
                "net_collections": m["net_collections"], "outstanding": m["outstanding_receivables"],
                "difference": m["reconciliation_difference"],
            })
        cursor = nxt
    cols = [col("period", {"day": "Business day", "week": "Week", "month": "Month"}[group], D if group == "day" else T),
            col("sales", "Sales", Q3), col("gross_sales", "Gross sales", M), col("cancellations", "Cancelled", M), col("refunds", "Refunds", M),
            col("adjustments", "Corrections", M), col("net_sales", "Net sales", M),
            *[col(f"cat_{c.pk}", f"{c.name} collected", M) for c in cats],
            col("payments_collected", "Payments collected", M), col("refunds_issued", "Refunds paid", M),
            col("net_collections", "Net collections", M), col("outstanding", "Outstanding credit", M),
            col("difference", "Reconciliation difference", M)]
    keys = [c["key"] for c in cols if c["kind"] in (M, Q3)]
    return cols, rows, keys


def payment_daily(params):
    return _reconciliation(params, "day")


def payment_weekly(params):
    return _reconciliation(params, "week")


def payment_monthly(params):
    return _reconciliation(params, "month")


def payment_providers(params):
    """One line per provider (and one per category without providers). Lines add up to the payments collected."""
    start, end = _range(params)
    rows = []
    for c in rec.breakdown(_filters(params, start, end)):
        lines = c["providers"] or [{**c, "name": "—"}]
        for p in lines:
            rows.append({"category": c["name"], "provider": p["name"], "payments": p["count"], "collected": p["amount"],
                         "verified": p["verified"], "refunds": p["refunds"], "net": p["net"],
                         "status": "" if p["is_active"] else "Switched off"})
    cols = [col("category", "Category"), col("provider", "Provider"), col("payments", "Payments", Q3), col("collected", "Collected", M),
            col("verified", "Of which checked", M), col("refunds", "Refunds paid", M), col("net", "Net collected", M), col("status", "Note")]
    return cols, rows, ["payments", "collected", "verified", "refunds", "net"]


def payment_cashiers(params):
    """Money each cashier took, by category. A split sale counts once in 'Sales' and once per method in the amounts."""
    start, end = _range(params)
    f = _filters(params, start, end)
    cats = _categories(start, end)
    table: dict = {}
    for r in rec.payments(f).values("sale__cashier", "sale__cashier__full_name", "sale__cashier__username", "method").annotate(amount=Sum("amount")):
        row = table.setdefault(r["sale__cashier"], {"cashier": r["sale__cashier__full_name"] or r["sale__cashier__username"]})
        row[f"cat_{r['method']}"] = r["amount"]
    for r in rec.payments(f).values("sale__cashier").annotate(sales=Count("sale", distinct=True), total=Sum("amount")):
        table[r["sale__cashier"]].update(sales=r["sales"], total=r["total"])
    for r in rec.refunds(f).values("sale__cashier", "sale__cashier__full_name", "sale__cashier__username").annotate(t=Sum("total")):
        row = table.setdefault(r["sale__cashier"], {"cashier": r["sale__cashier__full_name"] or r["sale__cashier__username"], "sales": 0, "total": ZERO})
        row["refunds"] = r["t"]
    rows = []
    for row in sorted(table.values(), key=lambda x: x["cashier"]):
        row = {"sales": 0, "total": ZERO, "refunds": ZERO, **{f"cat_{c.pk}": ZERO for c in cats}, **row}
        row["net"] = row["total"] - row["refunds"]
        rows.append(row)
    cols = [col("cashier", "Cashier"), col("sales", "Sales", Q3), *[col(f"cat_{c.pk}", c.name, M) for c in cats],
            col("total", "Collected", M), col("refunds", "Refunds on their sales", M), col("net", "Net collected", M)]
    return cols, rows, [c["key"] for c in cols if c["kind"] in (M, Q3)]


REPORTS = {
    "daily-sales": ("Daily sales and cumulative balance", daily_sales, True),
    "sales-by-product": ("Sales by product", sales_by_product, True),
    "sales-by-cashier": ("Sales by cashier", sales_by_cashier, True),
    "payment-summary": ("Payment methods", payment_summary, True),
    "closings": ("Daily closing and cash reconciliation", closings, True),
    "stock-on-hand": ("Stock on hand", stock_on_hand, False),
    "low-stock": ("Low and out-of-stock items", low_stock, False),
    "stock-daily": ("Stock movement by product", stock_daily, True),
    "damage-register": ("Damaged products register", damage_register, True),
    "damage-daily": ("Daily damaged products", damage_daily, True),
    "damage-monthly": ("Monthly damaged products", damage_monthly, True),
    "damage-by-product": ("Damage by product", damage_by_product, True),
    "damage-by-branch": ("Damage by branch", damage_by_branch, True),
    "purchases": ("Stock received (purchases)", purchases, True),
    "expenses": ("Expenses", expenses, True),
    "financial-summary": ("Sales, purchases and expenses", financial_summary, True),
    "payment-daily": ("Daily payment reconciliation", payment_daily, True),
    "payment-weekly": ("Weekly payment reconciliation", payment_weekly, True),
    "payment-monthly": ("Monthly payment reconciliation", payment_monthly, True),
    "payment-providers": ("Payments by category and provider", payment_providers, True),
    "payment-cashiers": ("Payments by cashier", payment_cashiers, True),
}
SECTIONS = {key: "Payment analysis" for key in REPORTS if key.startswith("payment-")}


def _plain(value):
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return str(value.quantize(Decimal("0.01"))) if value != value.to_integral_value() else str(int(value))
    return str(value)


class ReportListView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: list})
    def get(self, request):
        return Response([{"key": key, "title": title, "uses_dates": dated, "section": SECTIONS.get(key, "Sales, stock and money")}
                         for key, (title, _, dated) in REPORTS.items()])


class ReportView(APIView):
    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request, name):
        if name not in REPORTS:
            raise BusinessRuleError("We could not find that report.", code="not_found", status_code=404)
        title, build, dated = REPORTS[name]
        cols, rows, total_keys = build(request.query_params)
        rows = [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows]
        totals = {k: sum((row[k] or ZERO for row in rows), ZERO) for k in total_keys}
        start, end = _range(request.query_params) if dated else (None, None)

        fmt = request.query_params.get("download")
        if fmt:
            if fmt not in FORMATS:
                raise BusinessRuleError("Choose CSV or Excel.", code="bad_format", status_code=400)
            suffix = f"_{start}_to_{end}" if dated else f"_{local_today()}"
            audit(request.user, "report.exported", summary=f"Exported '{title}'" + (f" {start} to {end}" if dated else "") + f" ({fmt})")
            return table_response(fmt, f"meriba_{name}{suffix}", cols, rows, totals, title=title)

        return Response({
            "key": name, "title": title, "uses_dates": dated, "date_from": start, "date_to": end, "columns": cols,
            "rows": [{k: _plain(v) if isinstance(v, Decimal) else v for k, v in row.items()} for row in rows],
            "totals": {k: _plain(v) for k, v in totals.items()},
        })
