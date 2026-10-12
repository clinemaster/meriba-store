"""The only place that changes stock. Every change goes through post_movement()."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, get_branch, local_today

from .models import InventoryMovement, StockAdjustment, StockAdjustmentLine, StockBalance


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
    """Set products to their counted quantities. `lines` is a list of (product, counted_quantity).

    Opening counts are allowed only before go-live and only for products with no stock history.
    """
    existing = StockAdjustment.objects.filter(request_key=request_key).first()
    if existing:
        return existing, False

    branch = get_branch()
    cfg = BusinessSettings.objects.select_for_update().get(branch=branch)
    is_opening = kind == StockAdjustment.Kind.OPENING
    if is_opening and cfg.is_live:
        raise BusinessRuleError(
            "Opening stock can only be entered before the shop goes live. Use a stock adjustment instead.",
            code="already_live",
        )
    if not is_opening and not cfg.is_live:
        raise BusinessRuleError("Enter opening stock first. Adjustments start after the shop goes live.", code="not_live")

    adjustment = StockAdjustment.objects.create(
        branch=branch, kind=kind, reason=reason, request_key=request_key, created_by=user
    )
    business_date = current_business_date(branch)
    changed = 0
    for product, counted in sorted(lines, key=lambda line: line[0].pk):
        counted = Decimal(counted)
        StockBalance.objects.get_or_create(branch=branch, product=product)
        before = StockBalance.objects.select_for_update().get(branch=branch, product=product).quantity
        if is_opening and InventoryMovement.objects.filter(branch=branch, product=product).exists():
            raise BusinessRuleError(
                f"Opening stock for {product} has already been entered.", code="opening_exists",
                details={"product": product.pk},
            )
        StockAdjustmentLine.objects.create(
            adjustment=adjustment, product=product, quantity_before=before, quantity_counted=counted
        )
        if counted != before:
            post_movement(
                branch=branch, product=product, delta=counted - before,
                movement_type=InventoryMovement.Type.OPENING if is_opening else InventoryMovement.Type.ADJUSTMENT,
                source_type="StockAdjustment", source_id=adjustment.pk, user=user,
                business_date=business_date, reason=reason,
            )
            changed += 1
    audit(user, "stock.opening_entered" if is_opening else "stock.adjusted", adjustment,
          summary=f"{adjustment.get_kind_display()}: {len(lines)} products counted, {changed} changed", reason=reason,
          after={str(p.pk): c for p, c in lines})
    return adjustment, True


@transaction.atomic
def confirm_opening_stock(*, user):
    cfg = BusinessSettings.objects.select_for_update().get(branch=get_branch())
    if cfg.is_live:
        raise BusinessRuleError("The shop is already live.", code="already_live")
    counted = InventoryMovement.objects.filter(branch=cfg.branch, movement_type=InventoryMovement.Type.OPENING).count()
    cfg.opening_stock_confirmed_at = timezone.now()
    cfg.opening_stock_confirmed_by = user
    cfg.save(update_fields=["opening_stock_confirmed_at", "opening_stock_confirmed_by"])
    audit(user, "stock.opening_confirmed", cfg, summary=f"Opening stock confirmed ({counted} products with stock)")
    return cfg
