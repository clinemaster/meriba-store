"""Add the products on the latest imported Excel sheet to the product table.

    python manage.py add_excel_products --owner <username>            shows what would happen; saves nothing
    python manage.py add_excel_products --owner <username> --commit   does it

Uses only what the sheet states. Lines that need the Owner's decision are listed and left alone. Creates no stock.
Where the sheet does not say what one unit is, the Owner's answer can be given per S/N:

    --unit 11=Bottle --unit 3=Pack --size 20=5000ml
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from catalog.models import SoldBy
from history import services


def _by_serial(pairs, label):
    """Turn ["11=Bottle", ...] into {11: "Bottle", ...}."""
    found = {}
    for pair in pairs:
        serial, _, value = pair.partition("=")
        if not serial.strip().isdigit() or not value.strip():
            raise CommandError(f"--{label} must look like 11=Bottle, not '{pair}'.")
        found[int(serial)] = value.strip()
    return found


class Command(BaseCommand):
    help = "Add the products on the latest imported Excel sheet to the product table (dry run unless --commit)."

    def add_arguments(self, parser):
        parser.add_argument("--owner", required=True, help="Username of the Owner on whose request this is done")
        parser.add_argument("--commit", action="store_true", help="Save the products. Without this nothing is saved.")
        parser.add_argument("--unit", action="append", default=[], metavar="SN=UNIT",
                            help="The Owner's answer for a line whose unit the sheet does not state, e.g. 11=Bottle. Repeatable.")
        parser.add_argument("--size", action="append", default=[], metavar="SN=SIZE",
                            help="Size for a line given with --unit, e.g. 20=5000ml. Repeatable.")

    def handle(self, *args, owner, commit, unit, size, **options):
        user = get_user_model().objects.filter(username=owner, is_active=True).first()
        if user is None or not user.is_owner:
            raise CommandError(f"'{owner}' is not an active Owner.")
        units, sizes = _by_serial(unit, "unit"), _by_serial(size, "size")
        approved = {u.lower(): u for u in SoldBy.values}
        bad = [u for u in units.values() if u.lower() not in approved]
        if bad:
            raise CommandError(f"Unknown unit {bad}. Choose from: {', '.join(SoldBy.values)}.")
        units = {serial: approved[u.lower()] for serial, u in units.items()}
        with transaction.atomic():
            result = services.products_from_latest_sheet(owner=user, commit=commit, units=units, sizes=sizes)
        money = lambda v: "no price" if v is None else f"{v:,.0f}"
        self.stdout.write(f"Sheet: {result['sheet']}   {'SAVED' if commit else 'DRY RUN: nothing saved'}")
        for title, key in (("New products", "created"), ("Matched to a product that already exists", "mapped_to_existing")):
            self.stdout.write(f"\n{title}: {len(result[key])}")
            for r in result[key]:
                extra = "" if r.get("on_sale", True) else "   NOT ON SALE (no price)"
                self.stdout.write(f"  {r['serial']:>4}  {r['name']:<28} {r['unit']:<7} {r['size']:<8} sells {money(r['selling_price']):>8}  buys {money(r['purchase_price']):>8}{extra}")
        self.stdout.write(f"\nLeft for the Owner to decide: {len(result['left_for_owner'])}")
        for r in result["left_for_owner"]:
            self.stdout.write(f"  {r['serial']:>4}  {r['name']:<28} {r['why']}")
        self.stdout.write(f"\nAlready decided earlier: {result['already_done']}")
