"""Stock level of a product: healthy, low, critical or out of stock.

One rule, used by every screen, report and alert. It only reads the quantity the stock ledger already holds
(the live balance); it never works stock out itself.

    Out of stock   quantity is zero
    Critical       at or below the product's critical level (when one is set)
    Low            at or below the product's low-stock level (when one is set)
    Healthy        above both

A level of 0 means "no warning". When both are set, the critical level is lower than the low-stock level.
"""
from decimal import Decimal

from django.db.models import Case, CharField, F, Q, Value, When

ZERO = Decimal("0")

IN_STOCK = "IN_STOCK"
LOW_STOCK = "LOW_STOCK"
CRITICAL = "CRITICAL"
OUT_OF_STOCK = "OUT_OF_STOCK"

# From best to worst. The position is the severity used to tell when a product has got worse.
ORDER = [IN_STOCK, LOW_STOCK, CRITICAL, OUT_OF_STOCK]
LABELS = {IN_STOCK: "Healthy", LOW_STOCK: "Low stock", CRITICAL: "Critical stock", OUT_OF_STOCK: "Out of stock"}


def stock_status(quantity, reorder_point=ZERO, critical_point=ZERO) -> str:
    quantity, reorder_point, critical_point = (Decimal(v or 0) for v in (quantity, reorder_point, critical_point))
    if quantity <= 0:
        return OUT_OF_STOCK
    if critical_point > 0 and quantity <= critical_point:
        return CRITICAL
    if reorder_point > 0 and quantity <= reorder_point:
        return LOW_STOCK
    return IN_STOCK


def severity(status: str) -> int:
    return ORDER.index(status)


def status_expression(quantity: str = "stock_on_hand") -> Case:
    """The same rule as stock_status(), for the database, so lists can be filtered and counted by level."""
    return Case(
        When(**{f"{quantity}__lte": 0}, then=Value(OUT_OF_STOCK)),
        When(Q(critical_point__gt=0) & Q(**{f"{quantity}__lte": F("critical_point")}), then=Value(CRITICAL)),
        When(Q(reorder_point__gt=0) & Q(**{f"{quantity}__lte": F("reorder_point")}), then=Value(LOW_STOCK)),
        default=Value(IN_STOCK),
        output_field=CharField(),
    )


def parse_statuses(text: str | None) -> list[str]:
    """`?stock_status=LOW_STOCK,CRITICAL` → the known levels asked for. "ATTENTION" means every level but healthy."""
    wanted = []
    for part in (text or "").upper().split(","):
        part = part.strip()
        if part == "ATTENTION":
            wanted += [LOW_STOCK, CRITICAL, OUT_OF_STOCK]
        elif part in ORDER:
            wanted.append(part)
    return list(dict.fromkeys(wanted))
