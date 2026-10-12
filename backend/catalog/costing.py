"""Weighted-average costing.

The average cost of a product is the total cost of the units in stock divided by their number.
A delivery changes it:   new average = (in stock × old average + received × delivery cost) ÷ (in stock + received)
A sale does not change it: each sale line simply records the average at that moment as its cost.

Two rules protect the figures:
- the latest purchase price is never applied to units already in stock;
- where a cost had to be assumed (a delivery recorded with no cost), the product is marked "provisional"
  and so is the profit on anything sold from it, rather than presenting a guess as fact.
"""
from decimal import ROUND_HALF_UP, Decimal

from .models import Product

FOUR_PLACES = Decimal("0.0001")


def received(product_id: int, on_hand_before: Decimal, quantity: Decimal, unit_cost: Decimal | None):
    """Update the average after stock comes in. Must run inside the same transaction as the stock movement.

    Returns (average before, average after).
    """
    product = Product.objects.select_for_update().get(pk=product_id)
    before = product.average_cost
    # A delivery with no cost is carried at what we already believe a unit costs; that is an assumption.
    assumed = unit_cost if unit_cost is not None else (before if before is not None else product.cost_price)
    if assumed is None:
        return before, before  # still no reliable cost: stays unknown

    provisional = product.cost_provisional or unit_cost is None
    if before is None:
        if on_hand_before > 0:
            provisional = True  # units already in stock have no recorded cost of their own
        after = Decimal(assumed)
    elif on_hand_before <= 0:
        after = Decimal(assumed)  # nothing left of the old stock: start afresh from this delivery
        provisional = unit_cost is None
    else:
        after = (on_hand_before * before + quantity * Decimal(assumed)) / (on_hand_before + quantity)
    product.average_cost = after.quantize(FOUR_PLACES, rounding=ROUND_HALF_UP)
    product.cost_provisional = provisional
    product.save(update_fields=["average_cost", "cost_provisional", "updated_at"])
    return before, product.average_cost


def opening_stock_approved(product_id: int):
    """Opening stock is valued at the purchase price the Owner entered for the product, if there is one."""
    product = Product.objects.select_for_update().get(pk=product_id)
    if product.average_cost is None and product.cost_price is not None:
        product.average_cost = Decimal(product.cost_price).quantize(FOUR_PLACES)
        product.cost_provisional = False
        product.save(update_fields=["average_cost", "cost_provisional", "updated_at"])
