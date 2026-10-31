"""Read-only check of the payment records, to run before and after the payment-provider migration.

    python manage.py payment_migration_report            # totals by category and status, and the sales check
    python manage.py payment_migration_report --save before.json
    python manage.py payment_migration_report --compare before.json

It only reads. It works on the database before the migration too, because it reads only columns that existed then.
"""
import json
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.models import Count, Q, Sum

from sales.models import Payment, Refund, Sale


def _figures() -> dict:
    payments = {
        f"{r['method__code']}/{r['status']}": {"count": r["n"], "amount": str(r["t"])}
        for r in Payment.objects.values("method__code", "status").annotate(n=Count("id"), t=Sum("amount")).order_by("method__code", "status")
    }
    sales = Sale.objects.aggregate(
        completed=Sum("total", filter=Q(status="COMPLETED")), n=Count("id", filter=Q(status="COMPLETED")), voided=Count("id", filter=Q(status="VOIDED"))
    )
    kept = Payment.objects.filter(sale__status="COMPLETED").exclude(status="REVERSED").aggregate(t=Sum("amount"))["t"] or Decimal("0")
    # Every completed sale must be fully covered by its payments (credit sales are not enabled).
    uncovered = [
        s["receipt_number"] for s in Sale.objects.filter(status="COMPLETED").values("receipt_number", "total")
        .annotate(paid=Sum("payments__amount")).order_by("receipt_number") if (s["paid"] or 0) != s["total"]
    ]
    refunds = Refund.objects.aggregate(n=Count("id"), t=Sum("total"))
    return {
        "payments": payments,
        "payment_rows": Payment.objects.count(),
        "completed_sales": {"count": sales["n"], "total": str(sales["completed"] or Decimal("0"))},
        "voided_sales": sales["voided"],
        "payments_on_completed_sales": str(kept),
        "sales_not_matching_payments": uncovered,
        "refunds": {"count": refunds["n"], "total": str(refunds["t"] or Decimal("0"))},
    }


def _has_provider_column() -> bool:
    with connection.cursor() as cursor:
        columns = [c.name for c in connection.introspection.get_table_description(cursor, Payment._meta.db_table)]
    return "provider_id" in columns


class Command(BaseCommand):
    help = "Read-only payment totals and checks, for before and after the payment-provider migration."

    def add_arguments(self, parser):
        parser.add_argument("--save", help="Write the figures to this JSON file")
        parser.add_argument("--compare", help="Compare with figures saved earlier; exits with an error if any differ")

    def handle(self, *args, **options):
        figures = _figures()
        out = self.stdout
        out.write("Payments by category and status:")
        for key, row in figures["payments"].items():
            out.write(f"  {key:<32} {row['count']:>6}  {Decimal(row['amount']):>16,.2f}")
        out.write(f"Completed sales: {figures['completed_sales']['count']} totalling {Decimal(figures['completed_sales']['total']):,.2f}")
        out.write(f"Payments kept on completed sales: {Decimal(figures['payments_on_completed_sales']):,.2f}")
        out.write(f"Refunds: {figures['refunds']['count']} totalling {Decimal(figures['refunds']['total']):,.2f}")
        if figures["sales_not_matching_payments"]:
            out.write(self.style.ERROR(f"Sales whose payments do not add up to the total: {', '.join(figures['sales_not_matching_payments'])}"))
        else:
            out.write(self.style.SUCCESS("Every completed sale is exactly covered by its payments."))

        if _has_provider_column():
            legacy = list(Payment.objects.filter(method__requires_provider=True, provider__isnull=True).exclude(status="REVERSED")
                          .select_related("method", "sale").order_by("id"))
            out.write(f"Payments with no provider recorded (flagged for review, not guessed): {len(legacy)}")
            for p in legacy:
                out.write(f"  PAY-{p.pk:06d}  {p.sale.receipt_number}  {p.method.name:<16} {p.amount:>14,.2f}  ref: {p.reference or '-'}")
        else:
            out.write("The payment-provider migration has not been applied yet.")

        if options.get("save"):
            with open(options["save"], "w", encoding="utf-8") as fh:
                json.dump(figures, fh, indent=2)
            out.write(f"Saved to {options['save']}")
        if options.get("compare"):
            with open(options["compare"], encoding="utf-8") as fh:
                earlier = json.load(fh)
            differences = [k for k in figures if figures[k] != earlier.get(k)]
            if differences:
                raise CommandError(f"Figures differ from {options['compare']}: {', '.join(differences)}")
            out.write(self.style.SUCCESS(f"Identical to {options['compare']}: no payment, sale or refund figure changed."))
