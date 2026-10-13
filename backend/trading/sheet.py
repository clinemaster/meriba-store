"""The Daily Sheet: the shop's Excel worksheet, one per business day, reproduced with the workbook's own formulas.

How the workbook calculates (established from all 31 sheets, 3,503 product lines, on 13 Oct 2026):

    Opening            = the previous sheet's Closing stock
    Total stock        = Opening + Add Purchases
    Closing stock      = Total stock - Sales
    Total Sales        = Sales x Sales price
    Profit             = Sales x (Sales price - Purchase price)
    Stock              = Closing stock x Sales price          (stock valued at SELLING price)
    T.Purchases        = Add Purchases x Purchase price

The person types only Add Purchases and Sales (and a price when it changes). An empty cell counts as zero.
These formulas are kept exactly. They are deliberately NOT replaced by the weighted-average cost used on the
Products screen: the two screens answer different questions and each says which rule it uses.
"""
from datetime import date
from decimal import Decimal

from django.db.models import Q, Sum

from core.services import get_branch
from inventory.models import InventoryMovement

from .models import BusinessDay, DailySheetLine

ZERO = Decimal("0")
T = InventoryMovement.Type
FIELDS = ["opening", "purchases", "total_stock", "sales", "closing_stock", "purchase_price", "sales_price",
          "total_sales", "profit", "stock", "total_purchases"]
SUMMED = ["purchases", "sales", "total_sales", "profit", "stock", "total_purchases"]


def excel_line(opening, purchases, sales, purchase_price, sales_price, other=ZERO) -> dict:
    """The workbook's formulas for one product line. `other` (returns, counts, breakages) does not exist in the
    workbook; it is zero for anything the workbook could express, and is added to closing stock when present."""
    opening, purchases, sales, other = (Decimal(v or 0) for v in (opening, purchases, sales, other))
    price = Decimal(sales_price or 0)
    total_stock = opening + purchases
    closing = total_stock - sales + other
    return {
        "opening": opening, "purchases": purchases, "total_stock": total_stock, "sales": sales, "closing_stock": closing,
        "purchase_price": purchase_price, "sales_price": price,
        "total_sales": sales * price,
        # With no purchase price the workbook would treat the blank as zero and overstate profit; left empty instead.
        "profit": None if purchase_price is None else sales * (price - Decimal(purchase_price)),
        "stock": closing * price,
        "total_purchases": None if purchase_price is None else purchases * Decimal(purchase_price),
        "other_movements": other,
    }


def live_lines(day: date) -> list[dict]:
    """Today's sheet, worked out from what has been recorded in the system so far."""
    from catalog.models import Product
    from sales.models import RefundItem, Sale, SaleItem

    branch = get_branch()
    ledger = InventoryMovement.objects.filter(branch=branch)
    opening = dict(ledger.filter(business_date__lt=day).values("product").annotate(q=Sum("quantity_delta")).values_list("product", "q"))
    today = {m["product"]: m for m in ledger.filter(business_date=day).values("product").annotate(
        purchases=Sum("quantity_delta", filter=Q(movement_type=T.RECEIPT)),
        sold=Sum("quantity_delta", filter=Q(movement_type__in=[T.SALE, T.VOID])),
        other=Sum("quantity_delta", filter=~Q(movement_type__in=[T.RECEIPT, T.SALE, T.VOID])),
    )}
    recorded = dict(SaleItem.objects.filter(sale__status=Sale.Status.COMPLETED, sale__business_day__date=day)
                    .values("product").annotate(v=Sum("line_total")).values_list("product", "v"))
    refunded = dict(RefundItem.objects.filter(refund__business_day__date=day).values("sale_item__product")
                    .annotate(v=Sum("amount")).values_list("sale_item__product", "v"))
    lines = []
    # Listed by S/No, the line number the product has on the Excel sheet.
    products = Product.objects.filter(Q(is_active=True) | Q(pk__in=list(opening) + list(today))).order_by("serial_number", "id")
    for position, p in enumerate(products, start=1):
        number = p.serial_number or position
        m = today.get(p.pk, {})
        line = excel_line(opening.get(p.pk), m.get("purchases"), -(m.get("sold") or ZERO), p.cost_price, p.selling_price, m.get("other"))
        # What the tills actually took. It differs from Sales x Sales price when a package was sold at its own
        # price, a price changed during the day, or money was refunded; the sheet says so rather than hide it.
        actual = (recorded.get(p.pk) or ZERO) - (refunded.get(p.pk) or ZERO)
        lines.append({"number": number, "product": p.pk, "details": str(p), "unit": p.base_unit, **line,
                      "recorded_sales_value": actual, "differs_from_recorded": actual != line["total_sales"]})
    return lines


def freeze(day: BusinessDay) -> int:
    """Keep the day's sheet as it stood at closing, the way a saved worksheet keeps its prices and figures."""
    if DailySheetLine.objects.filter(business_day=day).exists():
        return 0
    lines = live_lines(day.date)
    DailySheetLine.objects.bulk_create([
        DailySheetLine(business_day=day, product_id=l["product"], number=l["number"], details=l["details"][:200], unit=l["unit"],
                       recorded_sales_value=l["recorded_sales_value"], other_movements=l["other_movements"],
                       **{f: l[f] for f in FIELDS})
        for l in lines
    ])
    return len(lines)


def _from_frozen(day: BusinessDay) -> list[dict]:
    return [{"number": l.number, "product": l.product_id, "details": l.details, "unit": l.unit,
             **{f: getattr(l, f) for f in FIELDS}, "other_movements": l.other_movements,
             "recorded_sales_value": l.recorded_sales_value, "differs_from_recorded": l.recorded_sales_value != l.total_sales}
            for l in DailySheetLine.objects.filter(business_day=day).order_by("number")]


def _from_excel(day: date) -> list[dict]:
    """A day from the imported workbook: shown exactly as written. Where a written figure is not what the
    workbook's own formula gives (for example an empty Profit cell), the line is marked; nothing is corrected."""
    from history.models import HistoricalRecord

    lines = []
    for r in (HistoricalRecord.objects.filter(business_date=day).exclude(import_status="REJECTED")
              .select_related("source_product", "profit_correction").order_by("source_row")):
        expected = excel_line(r.opening_qty, r.purchases_qty, r.sold_qty, r.purchase_price, r.sales_price)
        written = {"opening": r.opening_qty, "purchases": r.purchases_qty, "total_stock": r.total_stock, "sales": r.sold_qty,
                   "closing_stock": r.closing_qty, "purchase_price": r.purchase_price, "sales_price": r.sales_price,
                   "total_sales": r.total_sales, "profit": r.profit, "stock": r.stock_value, "total_purchases": r.total_purchases}
        differs = [f for f in ("total_stock", "closing_stock", "total_sales", "profit", "stock", "total_purchases")
                   if (written[f] or ZERO) != (expected[f] or ZERO)]
        lines.append({"number": r.source_product.serial_number, "product": r.source_product.product_id, "details": r.source_product.source_name,
                      "unit": "", **written, "other_movements": ZERO, "recorded_sales_value": None, "differs_from_recorded": False,
                      "source": f"{r.worksheet} row {r.source_row}", "formula_differs": differs, "incomplete": r.incomplete,
                      # an Owner-approved figure for an empty Profit cell is shown beside the cell, never in it
                      "approved_profit": r.profit_correction.approved_value if hasattr(r, "profit_correction") else None})
    return lines


def sheet_for(day: date) -> dict:
    from history.models import HistoricalRecord

    branch = get_branch()
    business_day = BusinessDay.objects.filter(branch=branch, date=day).first()
    if business_day and business_day.status == BusinessDay.Status.CLOSED:
        source, lines = "CLOSED", _from_frozen(business_day)
        note = "This day is closed. The sheet is kept as it stood at closing."
    elif business_day:
        source, lines = "LIVE", live_lines(day)
        note = "This day is open. The sheet updates as sales and deliveries are recorded."
    elif HistoricalRecord.objects.filter(business_date=day).exists():
        source, lines = "EXCEL", _from_excel(day)
        note = "From the imported Excel workbook, exactly as written. Not reconciled."
    else:
        source, lines, note = "NONE", [], "There is no sheet for this date."
    totals = {f: sum((l[f] or ZERO for l in lines), ZERO) for f in SUMMED}
    days = set(BusinessDay.objects.filter(branch=branch).values_list("date", flat=True)) | set(
        HistoricalRecord.objects.values_list("business_date", flat=True).distinct())
    return {
        "date": day, "source": source, "note": note, "lines": lines, "totals": totals,
        "previous_date": max((d for d in days if d < day), default=None),
        "next_date": min((d for d in days if d > day), default=None),
        "lines_with_other_movements": sum(1 for l in lines if l["other_movements"]),
        "lines_differing_from_recorded": sum(1 for l in lines if l["differs_from_recorded"]),
        "lines_where_formula_differs": sum(1 for l in lines if l.get("formula_differs")),
    }


def compare_with_workbook() -> dict:
    """Run the workbook's formulas over every imported line and compare with what the workbook itself shows."""
    from history.models import HistoricalRecord

    checked, mismatches, blanks, breaks = 0, [], [], []
    previous = {}
    for r in HistoricalRecord.objects.select_related("source_product").order_by("business_date", "source_row").iterator():
        checked += 1
        expected = excel_line(r.opening_qty, r.purchases_qty, r.sold_qty, r.purchase_price, r.sales_price)
        written = {"total_stock": r.total_stock, "closing_stock": r.closing_qty, "total_sales": r.total_sales, "profit": r.profit,
                   "stock": r.stock_value, "total_purchases": r.total_purchases}
        where = f"{r.worksheet} row {r.source_row} {r.source_product.source_name}"
        for field, value in written.items():
            gives = expected[field] or ZERO
            shown = str(int(gives)) if gives == gives.to_integral_value() else str(gives.normalize())
            if value is None and gives != 0:
                blanks.append({"where": where, "column": field, "formula_gives": shown})
            elif value is not None and value != gives:
                mismatches.append({"where": where, "column": field, "written": str(value), "formula_gives": shown})
        before = previous.get(r.source_product.serial_number)
        if before and before[1] is not None and r.opening_qty is not None and before[1] != r.opening_qty:
            breaks.append({"where": where, "previous_sheet": before[0], "previous_closing": str(before[1]), "opening": str(r.opening_qty)})
        previous[r.source_product.serial_number] = (r.worksheet, r.closing_qty)
    return {"lines_checked": checked, "figures_checked": checked * 6, "mismatches": mismatches, "blank_cells": blanks,
            "opening_not_previous_closing": breaks}
