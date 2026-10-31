"""The only place that changes stock. Every change goes through post_movement()."""
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from catalog import costing, stock_levels
from catalog.models import Product
from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, get_branch, local_today, money

from .models import (InventoryMovement, OpeningCount, OpeningCountLine, StockAdjustment, StockAdjustmentLine, StockAlert,
                     StockBalance)


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
    _alert_if_worse(movement, product)
    return movement


def _alert_if_worse(movement, product):
    """Record a stock alert when this movement took the product to a worse stock level."""
    before = stock_levels.stock_status(movement.balance_before, product.reorder_point, product.critical_point)
    after = stock_levels.stock_status(movement.balance_after, product.reorder_point, product.critical_point)
    if stock_levels.severity(after) > stock_levels.severity(before):
        StockAlert.objects.create(branch=movement.branch, product=product, movement=movement,
                                  status_before=before, status_after=after, quantity=movement.balance_after)


@transaction.atomic
def record_count(*, user, kind, reason, request_key, lines, remarks="", evidence_reference=""):
    """After go-live: set products to their counted quantities. `lines` is a list of (product, counted_quantity)."""
    existing = StockAdjustment.objects.filter(request_key=request_key).first()
    if existing:
        if existing.kind != kind:
            raise BusinessRuleError("This request key was already used for a different stock change.", code="request_key_reused", status_code=409)
        return existing, False

    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if kind == StockAdjustment.Kind.OPENING:
        raise BusinessRuleError("Opening stock is entered on a count sheet and approved by the Owner.", code="use_opening_count")
    if kind in (StockAdjustment.Kind.DAMAGE, StockAdjustment.Kind.DAMAGE_REVERSAL):
        raise BusinessRuleError("Use the damaged product workflow for damage and reversals.", code="damage_workflow_required", status_code=400)
    if not cfg.is_live:
        raise BusinessRuleError("Stock adjustments start after the shop goes live. Before that, use the opening stock count.", code="not_live")

    business_date = current_business_date(branch)
    product_ids = {product.pk for product, _ in lines}
    locked_products = {
        product.pk: product
        for product in Product.objects.select_for_update().filter(pk__in=product_ids).order_by("pk")
    }
    if len(locked_products) != len(product_ids):
        raise BusinessRuleError("One or more products could not be found.", code="product_not_found", status_code=404)

    try:
        with transaction.atomic():
            adjustment = StockAdjustment.objects.create(
                branch=branch, business_date=business_date, kind=kind, reason=reason,
                remarks=remarks, evidence_reference=evidence_reference, request_key=request_key, created_by=user,
            )
    except IntegrityError:
        existing = StockAdjustment.objects.filter(request_key=request_key).first()
        if existing and existing.kind == kind:
            return existing, False
        raise

    changed = 0
    audit_lines = {}
    for submitted_product, counted in sorted(lines, key=lambda line: line[0].pk):
        product = locked_products[submitted_product.pk]
        counted = Decimal(counted)
        StockBalance.objects.get_or_create(branch=branch, product=product)
        before = StockBalance.objects.select_for_update().get(branch=branch, product=product).quantity
        damage_fields = {}
        if kind == StockAdjustment.Kind.DAMAGE:
            if counted >= before:
                raise BusinessRuleError(
                    f"Enter a damaged quantity greater than zero and no more than the available {before.normalize():f} {product.base_unit.lower()}(s).",
                    code="invalid_damage_quantity", status_code=400,
                )
            damaged = before - counted
            selling_price = money(product.selling_price)
            average_cost = product.average_cost
            damage_fields = {
                "damaged_quantity": damaged,
                "selling_price_at_damage": selling_price,
                "damage_value": money(damaged * selling_price),
                "average_cost_at_damage": average_cost,
                "inventory_cost_damage_value": None if average_cost is None else money(damaged * average_cost),
            }
        movement = None
        if counted != before:
            movement = post_movement(
                branch=branch, product=product, delta=counted - before, movement_type=InventoryMovement.Type.ADJUSTMENT,
                source_type="StockAdjustment", source_id=adjustment.pk, user=user,
                business_date=business_date, reason=reason,
            )
            changed += 1
        StockAdjustmentLine.objects.create(
            adjustment=adjustment, product=product, movement=movement,
            quantity_before=before, quantity_counted=counted, **damage_fields,
        )
        audit_lines[str(product.pk)] = (
            {"stock_before": before, "damaged_quantity": damage_fields["damaged_quantity"], "stock_after": counted,
             "selling_price": damage_fields["selling_price_at_damage"], "damage_value": damage_fields["damage_value"],
             "average_cost": damage_fields["average_cost_at_damage"], "inventory_cost_damage_value": damage_fields["inventory_cost_damage_value"]}
            if kind == StockAdjustment.Kind.DAMAGE else counted
        )
    audit(user, "stock.adjusted", adjustment,
          summary=f"{adjustment.get_kind_display()}: {len(lines)} products counted, {changed} changed", reason=reason,
          after={"lines": audit_lines, "remarks": remarks, "evidence_reference": evidence_reference}
          if kind == StockAdjustment.Kind.DAMAGE else audit_lines)
    return adjustment, True


@transaction.atomic
def record_damage(*, user, reason, request_key, lines, remarks="", evidence_reference=""):
    """Deduct damaged units once and snapshot their retail and weighted-average cost values."""
    existing = StockAdjustment.objects.filter(request_key=request_key).first()
    if existing:
        if existing.kind != StockAdjustment.Kind.DAMAGE:
            raise BusinessRuleError("This request key was already used for a different stock change.", code="request_key_reused", status_code=409)
        return existing, False
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise BusinessRuleError("Write the reason for the damage.", code="reason_required", status_code=400)
    if not lines:
        raise BusinessRuleError("Enter at least one damaged product.", code="damage_lines_required", status_code=400)
    if len({product.pk for product, _ in lines}) != len(lines):
        raise BusinessRuleError("Each product can appear only once in a damage record.", code="duplicate_product", status_code=400)

    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    if not cfg.is_live:
        raise BusinessRuleError("Damage can be recorded after the shop goes live.", code="not_live")
    products = {
        product.pk: product
        for product in Product.objects.select_for_update().filter(pk__in={p.pk for p, _ in lines}).order_by("pk")
    }
    if len(products) != len(lines):
        raise BusinessRuleError("One or more products could not be found.", code="product_not_found", status_code=404)

    business_date = current_business_date(branch)
    try:
        with transaction.atomic():
            adjustment = StockAdjustment.objects.create(
                branch=branch, business_date=business_date, kind=StockAdjustment.Kind.DAMAGE, reason=reason,
                remarks=(remarks or "").strip(), evidence_reference=(evidence_reference or "").strip(),
                request_key=request_key, created_by=user,
            )
    except IntegrityError:
        existing = StockAdjustment.objects.filter(request_key=request_key).first()
        if existing and existing.kind == StockAdjustment.Kind.DAMAGE:
            return existing, False
        raise

    audit_lines = {}
    for submitted_product, damaged_value in sorted(lines, key=lambda line: line[0].pk):
        product = products[submitted_product.pk]
        damaged = Decimal(damaged_value)
        if not damaged.is_finite() or damaged <= 0:
            raise BusinessRuleError("Damaged quantity must be greater than zero.", code="invalid_damage_quantity", status_code=400)
        StockBalance.objects.get_or_create(branch=branch, product=product)
        balance = StockBalance.objects.select_for_update().get(branch=branch, product=product)
        before = balance.quantity
        if damaged > before:
            raise BusinessRuleError(
                f"Cannot damage {damaged.normalize():f} {product.base_unit.lower()}(s); only {before.normalize():f} available.",
                code="insufficient_stock", status_code=409,
                details={"product": product.pk, "available": str(before), "damaged": str(damaged)},
            )
        after = before - damaged
        selling_price = money(product.selling_price)
        average_cost = product.average_cost
        damage_value = money(damaged * selling_price)
        cost_value = None if average_cost is None else money(damaged * average_cost)
        movement = post_movement(
            branch=branch, product=product, delta=-damaged, movement_type=InventoryMovement.Type.ADJUSTMENT,
            source_type="StockAdjustment", source_id=adjustment.pk, user=user,
            business_date=business_date, reason=reason,
        )
        StockAdjustmentLine.objects.create(
            adjustment=adjustment, product=product, movement=movement, quantity_before=before, quantity_counted=after,
            damaged_quantity=damaged, selling_price_at_damage=selling_price, damage_value=damage_value,
            average_cost_at_damage=average_cost, inventory_cost_damage_value=cost_value,
        )
        audit_lines[str(product.pk)] = {
            "stock_before": before, "damaged_quantity": damaged, "stock_after": after,
            "selling_price": selling_price, "damage_value": damage_value,
            "average_cost": average_cost, "inventory_cost_damage_value": cost_value,
            "movement": movement.pk,
        }

    audit(user, "stock.adjusted", adjustment,
          summary=f"Damaged or expired: {len(lines)} product(s), {len(lines)} movement(s)", reason=reason,
          after={"lines": audit_lines, "remarks": adjustment.remarks, "evidence_reference": adjustment.evidence_reference})
    return adjustment, True


@transaction.atomic
def reverse_damage(*, owner, adjustment_id, request_key, reason):
    """Owner-authorized full reversal. The original damage and its valuation remain immutable."""
    existing = StockAdjustment.objects.filter(request_key=request_key).first()
    if existing:
        if existing.kind != StockAdjustment.Kind.DAMAGE_REVERSAL:
            raise BusinessRuleError("This request key was already used for a different stock change.", code="request_key_reused", status_code=409)
        return existing, False
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise BusinessRuleError("Write the reason for reversing this damage record.", code="reason_required", status_code=400)

    branch = get_branch()
    BusinessSettings.objects.select_for_update().get(branch=branch)
    original = StockAdjustment.objects.select_for_update().filter(
        pk=adjustment_id, branch=branch, kind=StockAdjustment.Kind.DAMAGE,
    ).first()
    if original is None:
        raise BusinessRuleError("We could not find that damage record.", code="not_found", status_code=404)
    if StockAdjustment.objects.filter(reversal_of=original).exists():
        raise BusinessRuleError("This damage record has already been reversed.", code="already_reversed", status_code=409)
    lines = list(original.lines.select_related("product").order_by("product_id"))
    if not lines or any(line.damaged_quantity is None for line in lines):
        raise BusinessRuleError("This legacy damage record has no complete quantity snapshot and cannot be reversed here.", code="damage_snapshot_missing", status_code=409)
    products = {
        product.pk: product
        for product in Product.objects.select_for_update().filter(pk__in=[line.product_id for line in lines]).order_by("pk")
    }
    business_date = current_business_date(branch)
    reversal = StockAdjustment.objects.create(
        branch=branch, business_date=business_date, kind=StockAdjustment.Kind.DAMAGE_REVERSAL,
        reason=reason, remarks=f"Reversal of DR-{original.pk:06d}", request_key=request_key,
        created_by=owner, reversal_of=original,
    )
    audit_lines = {}
    for line in lines:
        product = products[line.product_id]
        quantity = line.damaged_quantity
        StockBalance.objects.get_or_create(branch=branch, product=product)
        balance = StockBalance.objects.select_for_update().get(branch=branch, product=product)
        before = balance.quantity
        after = before + quantity
        movement = post_movement(
            branch=branch, product=product, delta=quantity, movement_type=InventoryMovement.Type.ADJUSTMENT,
            source_type="StockAdjustment", source_id=reversal.pk, user=owner,
            business_date=business_date, reason=reason,
        )
        StockAdjustmentLine.objects.create(
            adjustment=reversal, product=product, movement=movement, quantity_before=before, quantity_counted=after,
        )
        audit_lines[str(product.pk)] = {
            "stock_before": before, "restored_quantity": quantity, "stock_after": after, "movement": movement.pk,
        }
    audit(owner, "stock.damage_reversed", reversal, reason=reason,
          summary=f"Reversed damaged-product record DR-{original.pk:06d}",
          before={"damage_record": original.pk}, after={"reversal_record": reversal.pk, "lines": audit_lines})
    return reversal, True


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
            if line.counted_quantity > 0:
                costing.opening_stock_approved(line.product_id)
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
