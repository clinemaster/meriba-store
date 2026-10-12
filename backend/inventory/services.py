"""The only place that changes stock. Every change goes through post_movement()."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, get_branch, local_today

from .models import InventoryMovement, OpeningCount, OpeningCountLine, StockAdjustment, StockAdjustmentLine, StockBalance


def current_business_date(branch):
    from trading.models import BusinessDay

    day = BusinessDay.objects.filter(branch=branch, status=BusinessDay.Status.OPEN).first()
    return day.date if day else local_today()


def post_movement(*, branch, product, delta, movement_type, source_type, source_id, user, business_date, reason=""):
    """Lock the product's balance row, check it cannot go negative, write the ledger line, update the balance.

    Must run inside transaction.atomic(). Callers moving several products must do so in
    product-id order so two requests can never wait on each other.
    """
    delta = Decimal(delta)
    StockBalance.objects.get_or_create(branch=branch, product=product)
    balance = StockBalance.objects.select_for_update().get(branch=branch, product=product)
    after = balance.quantity + delta
    if after < 0:
        raise BusinessRuleError(
            f"Not enough stock of {product}. Only {balance.quantity.normalize():f} left.",
            code="insufficient_stock",
            details={"product": product.pk, "available": str(balance.quantity)},
        )
    movement = InventoryMovement.objects.create(
        branch=branch, product=product, movement_type=movement_type, quantity_delta=delta,
        balance_before=balance.quantity, balance_after=after, business_date=business_date,
        source_type=source_type, source_id=str(source_id), user=user, reason=reason[:300],
    )
    balance.quantity = after
    balance.save(update_fields=["quantity", "updated_at"])
    return movement


@transaction.atomic
def record_count(*, user, kind, reason, request_key, lines):
    """After go-live: set products to their counted quantities. `lines` is a list of (product, counted_quantity)."""
    existing = StockAdjustment.objects.filter(request_key=request_key).first()
    if existing:
        return existing, False

    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if kind == StockAdjustment.Kind.OPENING:
        raise BusinessRuleError("Opening stock is entered on a count sheet and approved by the Owner.", code="use_opening_count")
    if not cfg.is_live:
        raise BusinessRuleError("Stock adjustments start after the shop goes live. Before that, use the opening stock count.", code="not_live")

    adjustment = StockAdjustment.objects.create(
        branch=branch, kind=kind, reason=reason, request_key=request_key, created_by=user
    )
    business_date = current_business_date(branch)
    changed = 0
    for product, counted in sorted(lines, key=lambda line: line[0].pk):
        counted = Decimal(counted)
        StockBalance.objects.get_or_create(branch=branch, product=product)
        before = StockBalance.objects.select_for_update().get(branch=branch, product=product).quantity
        StockAdjustmentLine.objects.create(
            adjustment=adjustment, product=product, quantity_before=before, quantity_counted=counted
        )
        if counted != before:
            post_movement(
                branch=branch, product=product, delta=counted - before, movement_type=InventoryMovement.Type.ADJUSTMENT,
                source_type="StockAdjustment", source_id=adjustment.pk, user=user,
                business_date=business_date, reason=reason,
            )
            changed += 1
    audit(user, "stock.adjusted", adjustment,
          summary=f"{adjustment.get_kind_display()}: {len(lines)} products counted, {changed} changed", reason=reason,
          after={str(p.pk): c for p, c in lines})
    return adjustment, True


# --- Opening stock: physical count sheet, then Owner approval -------------------------------

def opening_stock_state(branch) -> dict:
    """What still stands between the shop and an approved opening stock."""
    from catalog.models import Product

    counts = OpeningCount.objects.filter(branch=branch)
    counted_ids = OpeningCountLine.objects.filter(
        count__branch=branch, count__status=OpeningCount.Status.APPROVED
    ).values_list("product_id", flat=True)
    uncounted = Product.objects.filter(is_active=True).exclude(pk__in=counted_ids)
    approved = counts.filter(status=OpeningCount.Status.APPROVED).exists()
    pending = counts.filter(status=OpeningCount.Status.PENDING_REVIEW).exists()
    return {
        "approved": approved, "pending": pending, "uncounted": uncounted.count(),
        "uncounted_names": [str(p) for p in uncounted[:10]],
        # Complete only when every product on sale has an approved counted quantity (zero is a valid count).
        "complete": approved and not pending and not uncounted.exists(),
    }


def _reference_for(product):
    """Last historical figure for comparison on the count sheet. Reference only; never becomes stock."""
    try:
        from history.services import reference_quantity
    except ImportError:  # the history module is optional for the stock ledger
        return None, ""
    return reference_quantity(product)


@transaction.atomic
def save_opening_count(*, user, request_key, count_date, counted_by_name, lines, note="", count_id=None):
    """Create or update the pending count sheet. `lines` is a list of (product, counted_quantity)."""
    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if cfg.is_live:
        raise BusinessRuleError(
            "The shop is already live. Opening stock can no longer be changed; use a stock adjustment instead.", code="already_live"
        )
    if count_id is None:
        existing = OpeningCount.objects.filter(request_key=request_key).first()
        if existing:
            return existing, False
        if OpeningCount.objects.filter(branch=branch, status=OpeningCount.Status.PENDING_REVIEW).exists():
            raise BusinessRuleError(
                "A count sheet is already waiting for the Owner's review. Add to that sheet instead of starting another.",
                code="count_pending",
            )
        count = OpeningCount.objects.create(
            branch=branch, count_date=count_date, counted_by_name=counted_by_name.strip(), note=note.strip(),
            request_key=request_key, prepared_by=user,
        )
        created = True
    else:
        count = OpeningCount.objects.select_for_update().filter(pk=count_id, branch=branch).first()
        if count is None:
            raise BusinessRuleError("We could not find that count sheet.", code="not_found", status_code=404)
        if count.status != OpeningCount.Status.PENDING_REVIEW:
            raise BusinessRuleError(
                f"This count sheet has been {count.get_status_display().lower()} and can no longer be changed. "
                "Start a new count sheet for corrections.", code="count_closed",
            )
        count.count_date, count.counted_by_name, count.note = count_date, counted_by_name.strip(), note.strip()
        count.save(update_fields=["count_date", "counted_by_name", "note"])
        created = False

    for product, counted in lines:
        if not product.is_active:
            raise BusinessRuleError(f"{product} is switched off. Switch it on before counting it.", code="product_inactive", status_code=400)
        reference, source = _reference_for(product)
        OpeningCountLine.objects.update_or_create(
            count=count, product=product,
            defaults={"unit": product.base_unit, "counted_quantity": Decimal(counted),
                      "reference_quantity": reference, "reference_source": source},
        )
    audit(user, "stock.opening_count_saved", count,
          summary=f"Opening count sheet of {count.count_date}: {len(lines)} product(s) entered by {count.counted_by_name}",
          after={str(p.pk): c for p, c in lines})
    return count, created


@transaction.atomic
def review_opening_count(*, owner, count_id, approve: bool, note=""):
    """Owner's decision on a count sheet. Approval is the moment the counted quantities become live stock."""
    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if cfg.is_live:
        raise BusinessRuleError("The shop is already live.", code="already_live")
    count = OpeningCount.objects.select_for_update().filter(pk=count_id, branch=branch).first()
    if count is None:
        raise BusinessRuleError("We could not find that count sheet.", code="not_found", status_code=404)
    if count.status != OpeningCount.Status.PENDING_REVIEW:
        return count  # already decided: a repeated click changes nothing
    note = (note or "").strip()
    lines = list(count.lines.select_related("product").order_by("product_id"))

    if approve:
        if not lines:
            raise BusinessRuleError("This count sheet is empty. Enter the counted quantities first.", code="count_empty", status_code=400)
        posted = 0
        for line in lines:
            StockBalance.objects.get_or_create(branch=branch, product=line.product)
            before = StockBalance.objects.select_for_update().get(branch=branch, product=line.product).quantity
            line.approved_quantity = line.counted_quantity
            if line.counted_quantity != before:
                line.movement = post_movement(
                    branch=branch, product=line.product, delta=line.counted_quantity - before,
                    movement_type=InventoryMovement.Type.OPENING, source_type="OpeningCount", source_id=count.pk,
                    user=owner, business_date=count.count_date,
                    reason=f"Opening count of {count.count_date} by {count.counted_by_name}",
                )
                posted += 1
            line.save(update_fields=["approved_quantity", "movement"])
        count.status = OpeningCount.Status.APPROVED
    else:
        if len(note) < 5:
            raise BusinessRuleError("Write why the count sheet is being rejected, so it can be recounted.", code="note_required", status_code=400)
        count.status = OpeningCount.Status.REJECTED
    count.reviewed_by, count.reviewed_at, count.review_note = owner, timezone.now(), note[:300]
    count.save()

    state = opening_stock_state(branch)
    cfg.opening_stock_confirmed_at = timezone.now() if state["complete"] else None
    cfg.opening_stock_confirmed_by = owner if state["complete"] else None
    cfg.save(update_fields=["opening_stock_confirmed_at", "opening_stock_confirmed_by"])
    audit(owner, "stock.opening_count_approved" if approve else "stock.opening_count_rejected", count, reason=note,
          summary=f"Opening count sheet of {count.count_date} {'approved' if approve else 'rejected'} ({len(lines)} products)",
          after={"status": count.status, "opening_stock_complete": state["complete"],
                 "quantities": {str(line.product_id): line.counted_quantity for line in lines} if approve else None})
    return count
