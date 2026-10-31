"""Completing and cancelling sales. A sale, its payments and its stock deductions commit together or not at all."""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from core.errors import BusinessRuleError
from core.models import BusinessSettings
from core.services import audit, money
from inventory.models import InventoryMovement
from inventory.services import post_movement
from trading.models import BusinessDay, CashierShift

from .models import Payment, Sale, SaleItem

ZERO = Decimal("0.00")


def _bad(message: str, code: str, details=None) -> BusinessRuleError:
    return BusinessRuleError(message, code=code, status_code=400, details=details)


def _price_lines(items) -> list[dict]:
    """Merge repeated products, apply server-side prices and unit conversions."""
    merged: dict[tuple, dict] = {}
    for item in items:
        product, unit, quantity = item["product"], item.get("unit"), Decimal(item["quantity"])
        if quantity <= 0:
            raise _bad("Enter a quantity greater than zero.", "bad_quantity")
        if quantity != quantity.to_integral_value():
            raise _bad(f"Enter a whole number for {product}.", "bad_quantity")
        if not product.is_active:
            raise _bad(f"{product} is no longer on sale.", "product_inactive", {"product": product.pk})
        if unit is not None:
            if unit.product_id != product.pk or not unit.is_active:
                raise _bad(f"That selling unit does not belong to {product}.", "bad_unit")
            if not unit.is_verified:
                raise _bad(
                    f"{product} cannot be sold by the {unit.name} yet. The Owner must confirm how many "
                    f"{product.base_unit}s it contains.", "unit_unverified",
                )
            name, factor, price = unit.name, unit.factor, unit.selling_price
        else:
            name, factor, price = product.base_unit, Decimal("1"), product.selling_price
        if price <= 0:
            raise _bad(f"{product} has no selling price. Ask the Owner to set one.", "no_price", {"product": product.pk})
        key = (product.pk, unit.pk if unit else None)
        if key in merged:
            merged[key]["quantity"] += quantity
        else:
            merged[key] = {"product": product, "unit_name": name, "factor": factor, "price": price, "quantity": quantity}
    lines = list(merged.values())
    for line in lines:
        line["quantity_base"] = line["quantity"] * line["factor"]
        line["line_total"] = money(line["quantity"] * line["price"])
    return lines


def check_provider(method, provider):
    """The provider rules for one payment or refund. Returns the provider to store (or None)."""
    if not method.is_active:
        raise _bad(f"{method.name} is not accepted at the moment.", "method_inactive")
    if provider is not None:
        if provider.category_id != method.pk:
            raise _bad(f"{provider.name} is not a {method.name} provider.", "provider_mismatch")
        if not provider.is_active:
            raise _bad(f"{provider.name} is not accepted at the moment. Choose another {method.name} provider.", "provider_inactive")
    elif method.requires_provider:
        names = ", ".join(method.providers.filter(is_active=True).values_list("name", flat=True))
        if not names:
            raise _bad(f"{method.name} has no provider switched on, so it cannot be used.", "no_active_provider")
        raise _bad(f"Choose which {method.name} provider was used ({names}).", "provider_required", {"method": method.pk})
    return provider


def payment_label(method, provider_name="") -> str:
    return f"{method.name} · {provider_name}" if provider_name else method.name


def _allocate_payments(payments, total: Decimal, cfg: BusinessSettings) -> tuple[list[dict], Decimal]:
    """Work out how much of each payment is kept. Only cash can be over-paid; the extra is change."""
    if not payments:
        raise _bad("Choose how the customer is paying.", "no_payment")
    if len(payments) > 1 and not cfg.split_payments_enabled:
        raise _bad("A sale can be paid with one payment method only.", "split_disabled")
    rows, seen = [], set()
    for p in payments:
        method, amount = p["method"], money(p["amount"])
        provider = check_provider(method, p.get("provider"))
        key = (method.pk, getattr(provider, "pk", None))
        if key in seen:
            raise _bad(f"{payment_label(method, getattr(provider, 'name', ''))} appears twice. Put the whole amount on one line.", "duplicate_method")
        seen.add(key)
        if amount <= 0:
            raise _bad(f"Enter the amount paid by {payment_label(method, getattr(provider, 'name', ''))}.", "bad_amount")
        rows.append({"method": method, "provider": provider, "provider_name": getattr(provider, "name", ""),
                     "tendered": amount, "amount": amount, "reference": (p.get("reference") or "").strip()[:60]})

    non_cash = sum((r["tendered"] for r in rows if not r["method"].is_cash), ZERO)
    cash = sum((r["tendered"] for r in rows if r["method"].is_cash), ZERO)
    if non_cash > total:
        raise _bad("The mobile money or bank amount is more than the sale total. Please correct it.", "non_cash_over")
    if non_cash + cash < total:
        raise _bad(
            f"The amount paid is {total - non_cash - cash:,.0f} less than the total.", "underpaid",
            {"outstanding": str(total - non_cash - cash)},
        )
    # The change comes out of the cash handed over, once in total (not once per cash line).
    change = left = non_cash + cash - total
    for r in rows:
        if r["method"].is_cash and left > 0:
            taken = min(left, r["tendered"])
            r["amount"] = r["tendered"] - taken
            left -= taken
    if any(r["amount"] <= 0 for r in rows):
        raise _bad("The other payments already cover the total. Remove the cash amount.", "cash_not_needed")
    return rows, change


@transaction.atomic
def create_sale(*, cashier, request_key, items, payments) -> tuple[Sale, bool]:
    existing = Sale.objects.filter(request_key=request_key).first()
    if existing:
        if existing.cashier_id != cashier.pk:
            raise _bad("This sale could not be saved. Please start a new sale.", "request_key_conflict")
        return existing, False  # a repeated click or retry: hand back the sale already saved

    shift = CashierShift.objects.filter(cashier=cashier, status=CashierShift.Status.OPEN).first()
    if shift is None:
        raise BusinessRuleError("Start your day before making a sale.", code="no_open_shift")
    # Lock the day: serialises receipt numbers and cannot overlap with closing.
    day = BusinessDay.objects.select_for_update().get(pk=shift.business_day_id)
    shift.refresh_from_db()
    if day.status != BusinessDay.Status.OPEN or shift.status != CashierShift.Status.OPEN:
        raise BusinessRuleError("This day has been closed. No more sales can be added to it.", code="day_closed")
    cfg = BusinessSettings.objects.get(branch=day.branch)

    lines = _price_lines(items)
    subtotal = sum((line["line_total"] for line in lines), ZERO)
    total = subtotal  # discounts and taxes are not part of the approved configuration
    payment_rows, change = _allocate_payments(payments, total, cfg)

    day.last_receipt_seq += 1
    day.save(update_fields=["last_receipt_seq"])
    sale = Sale.objects.create(
        branch=day.branch, business_day=day, shift=shift, cashier=cashier, request_key=request_key,
        receipt_number=f"{day.branch.code}-{day.date:%Y%m%d}-{day.last_receipt_seq:04d}",
        subtotal=subtotal, discount_total=ZERO, total=total, amount_tendered=total + change, change_due=change,
    )
    # The workbook's rule (owner's decision, 13 Oct 2026): Profit = Sales x (Sales price - Purchase price), using the
    # product's purchase price on the day of the sale. That purchase price is frozen on the sale line now, so a later
    # price change cannot alter the profit of this sale. Weighted-average cost is not used. Unknown stays unknown.
    from catalog.models import Product

    costs = dict(Product.objects.filter(pk__in=[line["product"].pk for line in lines]).values_list("pk", "cost_price"))
    for line in lines:
        purchase_price = costs[line["product"].pk]
        line["unit_cost"] = None if purchase_price is None else purchase_price * line["factor"]
        line["cost_total"] = None if purchase_price is None else money(line["quantity_base"] * purchase_price)
        line["cost_provisional"] = False
    SaleItem.objects.bulk_create([
        SaleItem(sale=sale, product=line["product"], product_name=str(line["product"]), unit_name=line["unit_name"],
                 unit_factor=line["factor"], quantity=line["quantity"], quantity_base=line["quantity_base"],
                 unit_price=line["price"], line_total=line["line_total"], unit_cost=line["unit_cost"],
                 cost_total=line["cost_total"], cost_provisional=line["cost_provisional"])
        for line in lines
    ])
    Payment.objects.bulk_create([Payment(sale=sale, recorded_by=cashier, created_at=sale.created_at, **row) for row in payment_rows])

    # One stock movement per product, in product order so concurrent sales cannot deadlock.
    per_product: dict[int, dict] = {}
    for line in lines:
        entry = per_product.setdefault(line["product"].pk, {"product": line["product"], "qty": Decimal("0")})
        entry["qty"] += line["quantity_base"]
    for pk in sorted(per_product):
        post_movement(
            branch=day.branch, product=per_product[pk]["product"], delta=-per_product[pk]["qty"],
            movement_type=InventoryMovement.Type.SALE, source_type="Sale", source_id=sale.pk,
            user=cashier, business_date=day.date,
        )
    audit(cashier, "sale.completed", sale, summary=f"Sale {sale.receipt_number} for {total:,.0f}",
          after={"total": total, "items": len(lines),
                 "payments": [{"category": r["method"].code, "provider": r["provider_name"] or None, "amount": r["amount"],
                               "reference": r["reference"]} for r in payment_rows]})
    return sale, True


@transaction.atomic
def void_sale(*, sale_id, actor, reason) -> tuple[Sale, bool]:
    """Cancel a sale from the day that is still open: stock goes back, payments are marked reversed."""
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise _bad("Write the reason for cancelling this sale.", "reason_required")
    sale = Sale.objects.select_for_update().filter(pk=sale_id).first()
    if sale is None:
        raise BusinessRuleError("We could not find that sale.", code="not_found", status_code=404)
    if sale.status == Sale.Status.VOIDED:
        return sale, False
    if sale.refunds.exists():
        raise BusinessRuleError("Part of this sale has already been refunded, so it cannot be cancelled as a whole.", code="has_refund")
    day = BusinessDay.objects.select_for_update().get(pk=sale.business_day_id)
    if day.status != BusinessDay.Status.OPEN:
        raise BusinessRuleError(
            f"The day of {day} is closed, so this sale can no longer be cancelled. Use a refund instead; it is recorded on today's business day.", code="day_closed"
        )
    if CashierShift.objects.get(pk=sale.shift_id).status != CashierShift.Status.OPEN:
        raise BusinessRuleError(
            "The cashier's shift for this sale is already closed and counted, so it can no longer be cancelled here.",
            code="shift_closed",
        )
    sale.status = Sale.Status.VOIDED
    sale.voided_at = timezone.now()
    sale.voided_by = actor
    sale.void_reason = reason[:300]
    sale.save(update_fields=["status", "voided_at", "voided_by", "void_reason"])
    reversed_payments = [{"payment": p.pk, "category": p.method.code, "provider": p.provider_name or None, "amount": p.amount}
                         for p in sale.payments.select_related("method")]
    sale.payments.update(status=Payment.Status.REVERSED, updated_at=timezone.now())

    per_product: dict[int, dict] = {}
    for item in sale.items.select_related("product"):
        entry = per_product.setdefault(item.product_id, {"product": item.product, "qty": Decimal("0")})
        entry["qty"] += item.quantity_base
    for pk in sorted(per_product):
        post_movement(
            branch=sale.branch, product=per_product[pk]["product"], delta=per_product[pk]["qty"],
            movement_type=InventoryMovement.Type.VOID, source_type="Sale", source_id=sale.pk,
            user=actor, business_date=day.date, reason=reason,
        )
    audit(actor, "sale.voided", sale, summary=f"Cancelled sale {sale.receipt_number} ({sale.total:,.0f})", reason=reason,
          before={"status": "COMPLETED"}, after={"status": "VOIDED", "payments_reversed": reversed_payments})
    return sale, True


@transaction.atomic
def refund_sale(*, sale_id, actor, request_key, lines, method, reason, shift=None, reference="", provider=None):
    """Give money back for items of a completed sale.

    The refund belongs to the business day that is open NOW and is linked to the original sale.
    The original day, even if closed, is left exactly as it was.
    `lines` is a list of {"sale_item": SaleItem, "quantity": Decimal, "restock": bool}.
    """
    from django.db.models import Sum

    from .models import Refund, RefundItem

    existing = Refund.objects.filter(request_key=request_key).first()
    if existing:
        return existing, False
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise _bad("Write the reason for this refund.", "reason_required")
    if not lines:
        raise _bad("Choose at least one item to refund.", "no_items")

    sale = Sale.objects.select_for_update().filter(pk=sale_id).first()
    if sale is None:
        raise BusinessRuleError("We could not find that sale.", code="not_found", status_code=404)
    if sale.status != Sale.Status.COMPLETED:
        raise BusinessRuleError("This sale was cancelled, so there is nothing to refund.", code="sale_voided")
    day = BusinessDay.objects.select_for_update().filter(branch=sale.branch, status=BusinessDay.Status.OPEN).first()
    if day is None:
        raise BusinessRuleError(
            "No business day is open. A refund is recorded on the open day, so start the day first.", code="no_open_day"
        )
    provider = check_provider(method, provider)
    if method.is_cash:
        open_shifts = list(CashierShift.objects.filter(business_day=day, status=CashierShift.Status.OPEN))
        if shift is None and len(open_shifts) == 1:
            shift = open_shifts[0]
        elif shift is not None:
            # Re-read now that the day is locked: the shift may have been closed a moment ago.
            shift = next((s for s in open_shifts if s.pk == shift.pk), None)
        if shift is None or shift.business_day_id != day.pk or shift.status != CashierShift.Status.OPEN:
            raise _bad("Choose the open cashier drawer the cash is being taken from.", "shift_required")
    else:
        shift = None

    total, rows = ZERO, []
    for line in lines:
        item, quantity = line["sale_item"], Decimal(line["quantity"])
        if item.sale_id != sale.pk:
            raise _bad("One of the items does not belong to this sale.", "wrong_sale")
        if quantity <= 0 or quantity != quantity.to_integral_value():
            raise _bad("Enter a whole quantity greater than zero.", "bad_quantity")
        already = RefundItem.objects.filter(sale_item=item).aggregate(q=Sum("quantity"))["q"] or Decimal("0")
        if already + quantity > item.quantity:
            left = item.quantity - already
            raise _bad(
                f"Only {left.normalize():f} of {item.product_name} can still be refunded on this sale.", "over_refund",
                {"sale_item": item.pk, "refundable": str(left)},
            )
        amount = money(quantity * item.unit_price)
        total += amount
        restock = bool(line.get("restock", True))
        # Goods put back on the shelf take their cost back with them; damaged goods remain a cost.
        if not restock:
            cost_returned = ZERO
        elif item.unit_cost is None:
            cost_returned = None
        else:
            cost_returned = money(quantity * item.unit_cost)
        rows.append({"item": item, "quantity": quantity, "base": quantity * item.unit_factor, "amount": amount,
                     "restock": restock, "cost_returned": cost_returned})
    if len({r["item"].pk for r in rows}) != len(rows):
        raise _bad("Each item can appear only once in a refund.", "duplicate_item")

    refund = Refund.objects.create(
        sale=sale, business_day=day, shift=shift, method=method, provider=provider, provider_name=getattr(provider, "name", ""),
        total=total, reason=reason[:300],
        reference=(reference or "").strip()[:60], request_key=request_key, created_by=actor,
    )
    RefundItem.objects.bulk_create([
        RefundItem(refund=refund, sale_item=r["item"], quantity=r["quantity"], quantity_base=r["base"],
                   amount=r["amount"], restocked=r["restock"], cost_returned=r["cost_returned"]) for r in rows
    ])
    back: dict[int, dict] = {}
    for r in rows:
        if r["restock"]:
            entry = back.setdefault(r["item"].product_id, {"product": r["item"].product, "qty": Decimal("0")})
            entry["qty"] += r["base"]
    for pk in sorted(back):
        post_movement(
            branch=sale.branch, product=back[pk]["product"], delta=back[pk]["qty"],
            movement_type=InventoryMovement.Type.RETURN, source_type="Refund", source_id=refund.pk,
            user=actor, business_date=day.date, reason=reason,
        )
    audit(actor, "sale.refunded", sale, reason=reason,
          summary=f"Refund of {total:,.0f} on sale {sale.receipt_number} (sold {sale.business_day}), recorded on {day}",
          after={"refund": refund.pk, "total": total, "method": method.code, "provider": refund.provider_name or None, "restocked": {str(k): v["qty"] for k, v in back.items()},
                 "not_restocked": sum(1 for r in rows if not r["restock"])})
    return refund, True


@transaction.atomic
def correct_payment_provider(*, payment_id, actor, provider, reason) -> Payment:
    """Record which provider carried a payment. The amount, category and sale never change.

    Allowed for a payment with no provider recorded (those taken before providers existed), at any time; and to fix
    a wrong choice while the cashier's shift is still open. Once a shift is closed and counted, a recorded provider
    stays as it was. Kept in the audit history with the old and new provider and the reason.
    """
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise _bad("Explain clearly how you know which provider carried this payment.", "reason_required")
    payment = Payment.objects.select_for_update().select_related("sale", "method").filter(pk=payment_id).first()
    if payment is None:
        raise BusinessRuleError("We could not find that payment.", code="not_found", status_code=404)
    if payment.status == Payment.Status.REVERSED:
        raise BusinessRuleError("This payment belongs to a cancelled sale, so it is not changed.", code="payment_reversed")
    if provider.category_id != payment.method_id:
        raise _bad(f"{provider.name} is not a {payment.method.name} provider.", "provider_mismatch")
    if payment.provider_id == provider.pk:
        raise _bad(f"This payment is already recorded as {provider.name}.", "no_change")
    if payment.provider_id is not None:
        if CashierShift.objects.get(pk=payment.sale.shift_id).status != CashierShift.Status.OPEN:
            raise BusinessRuleError(
                "The cashier's shift for this payment is closed and counted, so its recorded provider stays as it is.",
                code="shift_closed",
            )
        if not provider.is_active:
            raise _bad(f"{provider.name} is switched off.", "provider_inactive")
    before = {"provider": payment.provider_name or None, "provider_id": payment.provider_id}
    payment.provider = provider
    payment.provider_name = provider.name
    payment.save(update_fields=["provider", "provider_name", "updated_at"])
    audit(actor, "payment.corrected", payment, reason=reason,
          summary=f"Provider of the {payment.method.name} payment of {payment.amount:,.0f} on {payment.sale.receipt_number} "
                  f"set to {provider.name}" + (f" (was {before['provider']})" if before["provider"] else " (was not recorded)"),
          before=before, after={"provider": provider.name, "provider_id": provider.pk, "amount": payment.amount,
                                "category": payment.method.code, "receipt": payment.sale.receipt_number})
    return payment
