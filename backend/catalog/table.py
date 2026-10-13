"""The product table: stock and sales figures per product for a business day or a range of days.

Every figure comes from the records, never from another figure on the screen:
- quantities from the stock ledger (in the product's Sold By unit);
- Total Sales from completed sales, less refunds given in the period;
- Profit as in the Excel workbook: quantity sold x (sales price - purchase price), with the purchase price of the
  day of the sale, frozen on each sale line. Weighted-average cost is not used (owner's decision, 13 Oct 2026);
- Stock from the live balance, not from adding up days.
"""
from collections import defaultdict
from datetime import date
from decimal import Decimal

from django.db.models import Count, Q, Sum

from core.errors import BusinessRuleError
from core.services import get_branch, local_today
from inventory.models import InventoryMovement, StockBalance
from inventory.services import current_business_date
from sales.models import RefundItem, Sale, SaleItem

from .models import Product

ZERO = Decimal("0")
T = InventoryMovement.Type
SALE_TYPES = [T.SALE, T.VOID]


def period(params) -> tuple[date, date]:
    """One business day by default (the open day, or today); or a from/to range."""
    try:
        if params.get("date"):
            day = date.fromisoformat(params["date"])
            return day, day
        default = current_business_date(get_branch())
        start = date.fromisoformat(params["date_from"]) if params.get("date_from") else default
        end = date.fromisoformat(params["date_to"]) if params.get("date_to") else max(start, default)
    except ValueError:
        raise BusinessRuleError("Choose valid dates.", code="bad_date", status_code=400)
    if start > end:
        raise BusinessRuleError("The 'from' date must be on or before the 'to' date.", code="bad_date", status_code=400)
    if start > local_today():
        raise BusinessRuleError("That date is in the future.", code="bad_date", status_code=400)
    return start, end


def rows_for(products, start: date, end: date) -> list[dict]:
    products = list(products)
    ids = [p.pk for p in products]
    branch = get_branch()
    ledger = InventoryMovement.objects.filter(branch=branch, product_id__in=ids)

    opening = dict(ledger.filter(business_date__lt=start).values("product").annotate(q=Sum("quantity_delta")).values_list("product", "q"))
    moves = {m["product"]: m for m in ledger.filter(business_date__range=(start, end)).values("product").annotate(
        incoming=Sum("quantity_delta", filter=Q(quantity_delta__gt=0) & ~Q(movement_type__in=SALE_TYPES)),
        sold=Sum("quantity_delta", filter=Q(movement_type__in=SALE_TYPES)),
        other_out=Sum("quantity_delta", filter=Q(quantity_delta__lt=0) & ~Q(movement_type__in=SALE_TYPES)),
        net=Sum("quantity_delta"),
    )}
    stock = dict(StockBalance.objects.filter(branch=branch, product_id__in=ids).values_list("product", "quantity"))

    sold = {s["product"]: s for s in SaleItem.objects.filter(
        product_id__in=ids, sale__status=Sale.Status.COMPLETED, sale__business_day__date__range=(start, end),
    ).values("product").annotate(
        revenue=Sum("line_total"), cost=Sum("cost_total"),
        no_cost=Count("id", filter=Q(cost_total__isnull=True)), provisional=Count("id", filter=Q(cost_provisional=True)),
    )}
    refunded = defaultdict(lambda: {"amount": ZERO, "cost": ZERO, "no_cost": 0})
    for r in RefundItem.objects.filter(sale_item__product_id__in=ids, refund__business_day__date__range=(start, end)).values(
            "sale_item__product").annotate(amount=Sum("amount"), cost=Sum("cost_returned"),
                                           no_cost=Count("id", filter=Q(cost_returned__isnull=True))):
        refunded[r["sale_item__product"]] = {"amount": r["amount"] or ZERO, "cost": r["cost"] or ZERO, "no_cost": r["no_cost"]}

    rows = []
    for p in products:
        m, s, back = moves.get(p.pk, {}), sold.get(p.pk, {}), refunded[p.pk]
        opening_qty = opening.get(p.pk) or ZERO
        incoming = m.get("incoming") or ZERO
        sales_qty = -(m.get("sold") or ZERO)
        other_out = -(m.get("other_out") or ZERO)
        total_sales = (s.get("revenue") or ZERO) - back["amount"]
        cost_of_goods = (s.get("cost") or ZERO) - back["cost"]
        # Gross profit = net sales revenue − cost of goods sold. If any line has no reliable cost, say so.
        if (s.get("no_cost") or 0) + back["no_cost"] > 0:
            profit, profit_status = None, "UNAVAILABLE"
        else:
            profit = total_sales - cost_of_goods
            profit_status = "PROVISIONAL" if s.get("provisional") else "OK"
        rows.append({
            "id": p.pk, "sku": p.sku, "name": p.name, "sold_by": p.base_unit, "volume_ml": p.volume_ml,
            "bottles_per_unit": p.bottles_per_unit, "is_active": p.is_active,
            "opening_stock": opening_qty, "incoming": incoming, "other_out": other_out,
            "total_item_stock": opening_qty + incoming,
            "sales": sales_qty,
            "closing_stock": opening_qty + (m.get("net") or ZERO),
            "purchase_price": p.cost_price, "purchase_price_provisional": False,
            "purchase_price_entered": p.cost_price,
            "selling_price": p.selling_price,
            "total_sales": total_sales, "cost_of_goods_sold": None if profit is None else cost_of_goods,
            "profit": profit, "profit_status": profit_status,
            "stock": stock.get(p.pk) or ZERO,
        })
    return rows


SORTABLE = {"name", "sold_by", "volume_ml", "total_item_stock", "sales", "closing_stock", "purchase_price",
            "selling_price", "total_sales", "profit", "stock"}


def sort_rows(rows: list[dict], ordering: str) -> list[dict]:
    key = (ordering or "name").lstrip("-")
    if key not in SORTABLE:
        key = "name"
    descending = (ordering or "").startswith("-")

    def value(row):
        v = row[key]
        return v.lower() if isinstance(v, str) else v

    present = sorted((r for r in rows if r[key] is not None), key=lambda r: (value(r), r["name"].lower()), reverse=descending)
    return present + [r for r in rows if r[key] is None]  # blanks always last


def totals(rows: list[dict]) -> dict:
    known = [r["profit"] for r in rows if r["profit"] is not None]
    return {
        "total_sales": sum((r["total_sales"] for r in rows), ZERO),
        "profit": sum(known, ZERO),
        "profit_unavailable_for": sum(1 for r in rows if r["profit"] is None),
        "profit_provisional_for": sum(1 for r in rows if r["profit_status"] == "PROVISIONAL"),
    }


def search(qs, text: str):
    for word in (text or "").split():
        qs = qs.filter(Q(name__icontains=word) | Q(sku__icontains=word) | Q(package_size__icontains=word)
                       | Q(brand__icontains=word) | Q(barcode=word))
    return qs


def base_queryset(params):
    qs = Product.objects.all()
    if params.get("active") == "true":
        qs = qs.filter(is_active=True)
    elif params.get("active") == "false":
        qs = qs.filter(is_active=False)
    if params.get("sold_by"):
        qs = qs.filter(base_unit=params["sold_by"])
    return search(qs, params.get("search", ""))
