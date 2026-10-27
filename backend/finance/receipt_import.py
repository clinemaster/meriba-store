"""Upload Received Stock: a workbook of deliveries, previewed, then added to stock as ordinary stock receipts.

1. read_workbook()  reads the five columns, exactly as written. Nothing is stored about stock yet.
2. analyse()        matches every row to one product and checks its unit, volume and quantity. Run again at
                    confirmation, so the decision rests on the products and stock as they are then.
3. confirm()        in one transaction, posts the ready rows through receive_stock(): the same ledger movements,
                    costing and audit as a delivery typed on the Receive Stock screen. Rows that are not ready are
                    skipped and listed; none of them changes anything.

Matching never guesses. A row is matched only when its Details are the product's name (ignoring case and spaces),
the product's name with its size, or a name the Owner has linked to the product in Excel History. When several
products share the name, the unit and volume must leave exactly one. Otherwise the row waits for the Owner to choose.
S/N is shown but never used to identify a product: the numbers differ from file to file.
"""
import io
import re
import uuid
from collections import defaultdict
from decimal import Decimal, InvalidOperation

import openpyxl
from django.db import transaction
from django.utils import timezone
from openpyxl.styles import Alignment, Font, PatternFill

from catalog.models import Product, SoldBy
from core.errors import BusinessRuleError
from core.services import audit, get_branch, get_settings
from history.models import SourceProduct
from history.parser import normalise_name, squash
from inventory.models import StockBalance

from .models import ReceiptImport
from .views import receive_stock

ZERO = Decimal("0")
HEADINGS = ["S/N", "Details", "Counted by or Unit", "Volume (ml)", "Quantity received"]
KEYS = ["sn", "details", "unit", "volume", "quantity"]
# What each column may be headed, compared without case or extra spaces.
ACCEPTED = {
    "sn": {"s/n", "s/no", "s/no.", "sn", "s.n", "s.no"},
    "details": {"details", "detail"},
    "unit": {"counted by or unit", "counted by", "unit", "counted by/unit", "counted by / unit"},
    "volume": {"volume (ml)", "volume(ml)", "volume ml", "volume"},
    "quantity": {"quantity received", "qty received", "quantity", "qty"},
}
HEADER_SEARCH_ROWS = 15
MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 2000

# Units as people write them, mapped to the approved Sold By units.
UNIT_WORDS = {word: unit for unit in SoldBy.values
              for word in {unit.lower(), unit.lower() + "s", unit.lower() + "es"}}
# Spellings used in the shop's own sheets (the workbook writes "CRET" for a crate).
UNIT_WORDS.update({"cret": "Crate", "crete": "Crate", "kreti": "Crate", "ctn": "Carton", "pkt": "Pack", "btl": "Bottle"})
PACK_TEXT = re.compile(r"^([a-z]+)\s*\(\s*(\d+)\s*\)$")  # "box (24)", "BOX(24)"


def _parse_unit(text: str):
    """"bottles" -> ("Bottle", None); "BOX(24)" -> ("Box", 24); "CRET" -> ("Crate", None); anything else -> (None, None)."""
    t = " ".join(text.lower().split())
    if t in UNIT_WORDS:
        return UNIT_WORDS[t], None
    match = PACK_TEXT.match(t)
    if match and match.group(1) in UNIT_WORDS:
        return UNIT_WORDS[match.group(1)], int(match.group(2))
    return None, None


def _pack_key(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


def _is_own_pack(product: Product, text: str) -> bool:
    """The file's unit is the pack recorded on the product (its Excel "pack" column), e.g. Bavaria "BOX(24)".
    The quantity is then in the product's own unit (owner's decision, 21 Oct 2026: "20 BOX(24)" = 20 bottles)."""
    return bool(text.strip()) and bool(product.pack_description) and _pack_key(text) == _pack_key(product.pack_description)

READY, UNMATCHED, AMBIGUOUS, INVALID, SKIPPED, EXCLUDED = "READY", "UNMATCHED", "AMBIGUOUS", "INVALID", "SKIPPED", "EXCLUDED"
STATUS_LABELS = {
    READY: "Ready to add", UNMATCHED: "Product not found", AMBIGUOUS: "Choose the product",
    INVALID: "Needs correcting", SKIPPED: "Not a product row", EXCLUDED: "Excluded by you",
}


# --- 1. Reading the file -------------------------------------------------------------------------

def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return squash(value)


def _heading_key(value) -> str | None:
    text = squash(value or "").lower()
    return next((key for key, names in ACCEPTED.items() if text in names), None)


def read_workbook(data: bytes, filename: str) -> list[dict]:
    """The rows under the heading row of the first sheet that has the five headings, as text."""
    if not filename.lower().endswith(".xlsx"):
        raise BusinessRuleError("Choose an Excel workbook ending in .xlsx. An older .xls file can be saved as .xlsx in Excel "
                                "(File → Save As → Excel Workbook).", code="bad_file", status_code=400)
    if len(data) > MAX_BYTES:
        raise BusinessRuleError("The file is too large (the limit is 5 MB).", code="too_large", status_code=400)
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        raise BusinessRuleError("This file could not be opened as an Excel workbook. Check that it is not damaged or "
                                "password-protected.", code="bad_file", status_code=400)

    best = {}
    for sheet in workbook.worksheets:
        rows = sheet.iter_rows(values_only=True)
        for number, values in enumerate(rows, start=1):
            if number > HEADER_SEARCH_ROWS:
                break
            found = {}
            for position, value in enumerate(values or ()):
                key = _heading_key(value)
                if key and key not in found:
                    found[key] = position
            if len(found) > len(best):
                best = found
            if len(found) == len(KEYS):
                positions = [found[k] for k in KEYS]
                if positions != sorted(positions):
                    raise BusinessRuleError(
                        f"The columns are not in the expected order. Put them as: {', '.join(HEADINGS)}.",
                        code="bad_columns", status_code=400, details={"expected": HEADINGS})
                return _rows_below(rows, number, positions, sheet.title)

    missing = [HEADINGS[i] for i, key in enumerate(KEYS) if key not in best]
    raise BusinessRuleError(
        f"Missing column(s): {', '.join(missing)}. The first row of the table must have these headings: "
        f"{', '.join(HEADINGS)}. Download the template to see the layout.",
        code="bad_columns", status_code=400, details={"missing": missing, "expected": HEADINGS})


def _rows_below(rows, header_row: int, positions: list[int], sheet: str) -> list[dict]:
    out = []
    for number, values in enumerate(rows, start=header_row + 1):
        values = list(values or ())
        cells = {key: _cell(values[pos]) if pos < len(values) else "" for key, pos in zip(KEYS, positions)}
        if not any(cells.values()):
            continue
        out.append({"row": number, "sheet": sheet, **cells})
        if len(out) > MAX_ROWS:
            raise BusinessRuleError(f"The file has more than {MAX_ROWS} rows. Split it into smaller files.", code="too_many_rows", status_code=400)
    if not out:
        raise BusinessRuleError("The file has the right headings but no rows under them.", code="no_rows", status_code=400)
    return out


def template() -> bytes:
    """An empty workbook with the five headings, and a second sheet saying how to fill it in."""
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Received stock"
    sheet.append(HEADINGS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDEBF7")
    for letter, width in zip("ABCDE", (8, 36, 20, 14, 20)):
        sheet.column_dimensions[letter].width = width
    sheet.freeze_panes = "A2"
    help_sheet = workbook.create_sheet("How to fill it in")
    for line in [
        "One row for each product that was delivered.",
        "S/N: your own row number. It is not used to find the product.",
        "Details: the product's name as it is in MERIBA (Products page), for example Konyagi ndogo.",
        f"Counted by or Unit: one of {', '.join(SoldBy.values)}. Use the unit the product is counted in, or a package the "
        "Owner has verified for it (for example Crate when a crate of 12 is set up).",
        "Volume (ml): the size of one bottle in millilitres, for example 750. Helps tell apart products with the same name.",
        "Quantity received: a whole number greater than zero, in the unit written in the row.",
        "Nothing changes until you have checked the preview and pressed confirm.",
    ]:
        help_sheet.append([line])
    help_sheet.column_dimensions["A"].width = 120
    for row in help_sheet.iter_rows():
        row[0].alignment = Alignment(wrap_text=True)
    out = io.BytesIO()
    workbook.save(out)
    return out.getvalue()


# --- 2. Checking and matching ---------------------------------------------------------------------

def _whole_number(text: str, what: str):
    """(value, problem). Accepts 24, "24", "1,200"."""
    try:
        number = Decimal(text.replace(",", "").strip())
    except InvalidOperation:
        return None, (f"{what} '{text}' is not a number.", f"Write {what.lower()} as a number, for example 24.")
    if not number.is_finite() or number <= 0:
        return None, (f"{what} must be greater than zero.", f"Write the {what.lower()} as a whole number greater than zero.")
    if number != number.to_integral_value():
        return None, (f"{what} {text} is not a whole number.", f"Write the {what.lower()} as a whole number.")
    return int(number), None


def _volume(text: str):
    cleaned = text.lower().replace("mls", "").replace("ml", "").strip()
    return _whole_number(cleaned, "Volume") if cleaned else (None, None)


def _label(p: Product) -> str:
    return str(p) + ("" if p.is_active else " (switched off)")


def _product_info(p: Product) -> dict:
    return {"id": p.pk, "label": _label(p), "base_unit": p.base_unit, "volume_ml": p.volume_ml, "serial_number": p.serial_number}


def _factor(p: Product, unit: str):
    """How many of the product's own units one of `unit` is, or None when the product is not set up for it."""
    if unit == p.base_unit:
        return Decimal("1")
    package = next((u for u in p.units.all() if u.name == unit and u.is_active and u.is_verified), None)
    return package.factor if package else None


# The shop's size words and the short forms used in product names ("Amarula ndg", "Hennesy kb", "JACK Daniel K").
# Only the LAST word of a name is read this way, and only when no product has the exact name.
SIZE_WORDS = {"kubwa": "kubwa", "kb": "kubwa", "kbw": "kubwa", "k": "kubwa",
              "ndogo": "ndogo", "ndg": "ndogo", "nd": "ndogo",
              "kati": "kati", "kat": "kati", "kt": "kati"}


def _size_key(name: str) -> str:
    """'Amarula ndogo' and 'Amarula ndg' -> 'amarula ndogo'. Everything else in the name must still be the same."""
    words = normalise_name(name).split()
    return " ".join(words[:-1] + [SIZE_WORDS.get(words[-1], words[-1])]) if words else ""


class _Catalogue:
    """Every product, findable by its name, its name with size, and the Excel names linked to it; and, when nothing
    has the exact name, by the same name with the size word written in full or short (ndogo/ndg, kubwa/kb/k, kati/kat)."""

    def __init__(self):
        self.products = {p.pk: p for p in Product.objects.prefetch_related("units")}
        self.by_name = defaultdict(set)
        for p in self.products.values():
            self.by_name[normalise_name(p.name)].add(p.pk)
            self.by_name[normalise_name(str(p))].add(p.pk)
        for name, pk in SourceProduct.objects.exclude(product=None).values_list("normalised_name", "product_id"):
            self.by_name[name].add(pk)
        self.by_size_word = defaultdict(set)
        for p in self.products.values():
            self.by_size_word[_size_key(p.name)].add(p.pk)
        self.stock = dict(StockBalance.objects.filter(branch=get_branch()).values_list("product", "quantity"))

    def candidates(self, details: str) -> tuple[list[Product], bool]:
        """The products with this name, and whether they were found only through the size word."""
        exact = self.by_name.get(normalise_name(details), ())
        found = exact or self.by_size_word.get(_size_key(details), ())
        return sorted((self.products[pk] for pk in found), key=lambda p: (p.name, p.pk)), not exact and bool(found)


EDITABLE = ("unit", "volume", "quantity")


def _check_row(raw: dict, catalogue: _Catalogue, edit: dict) -> dict:
    """One row, with the Owner's corrections (if any) applied over what the file says. The file's values are kept."""
    problems, notes = [], []

    def problem(text, fix):
        problems.append({"problem": text, "fix": fix})

    values = {**raw, **{k: str(edit[k]).strip() for k in EDITABLE if k in edit}}
    row = {**values, "uploaded": {k: raw[k] for k in ("details", *EDITABLE)},
           "edited": [k for k in EDITABLE if k in edit and str(edit[k]).strip() != raw[k]],
           "excluded": bool(edit.get("excluded")), "status": None, "problems": problems, "notes": notes,
           "product": None, "candidates": [], "chosen": "product" in edit, "name_differs": False,
           "factor": None, "adds": None, "stock_before": None, "duplicate": False}
    details = raw["details"]
    if normalise_name(details) in {"total", "totals", "grand total"} and "product" not in edit:
        row.update(status=SKIPPED)
        notes.append("A total line. Not added to stock.")
        return row

    if not details and "product" not in edit:
        problem("No product name in Details.", "Choose the product, or exclude the row.")
    quantity = None
    if not values["quantity"]:
        problem("Quantity received is empty.", "Enter how many came in, or exclude the row.")
    else:
        quantity, issue = _whole_number(values["quantity"], "Quantity")
        if issue:
            problem(*issue)
    unit, per_pack = _parse_unit(values["unit"])
    row["unit_name"] = unit  # the shop's own unit for what the file wrote ("bottles" -> "Bottle"); None if not one
    if not values["unit"]:
        problem("Counted by or Unit is empty.", f"Choose one of: {', '.join(SoldBy.values)}.")
    volume, issue = _volume(values["volume"])
    if issue:
        problem(*issue)

    # Which product is it? The Owner's choice first; otherwise only a certain match.
    candidates, by_size_word = catalogue.candidates(details) if details else ([], False)
    if len(candidates) > 1:
        row["candidates"] = [_product_info(p) for p in candidates]
    product = None
    if "product" in edit:
        product = catalogue.products.get(edit["product"])
        if product is None:
            problem("The product chosen no longer exists.", "Choose the product again.")
        else:
            notes.append("Product chosen by you.")
    elif details and not candidates:
        row["status"] = UNMATCHED
        problem(f"No product called '{details}' was found.",
                "Choose the right product, add it on the Products page first, or exclude the row.")
    elif len(candidates) == 1:
        product = candidates[0]
    elif len(candidates) > 1:
        fitting = [p for p in candidates
                   if (_is_own_pack(p, values["unit"]) or unit is None or _factor(p, unit) is not None)
                   and (volume is None or p.volume_ml == volume)]
        if len(fitting) == 1:
            product = fitting[0]
            notes.append(f"{len(candidates)} products are called '{details}'; the unit and volume leave only this one.")
        else:
            row["status"] = AMBIGUOUS
            problem(f"{len(candidates)} products are called '{details}' and the unit and volume do not tell them apart.",
                    "Choose the right product.")

    if product is not None:
        row["product"] = _product_info(product)
        row["stock_before"] = catalogue.stock.get(product.pk, ZERO)
        # Shown, so a row matched to something with another name is never missed (an Excel History name, or a choice).
        row["name_differs"] = bool(details) and normalise_name(details) not in {normalise_name(product.name), normalise_name(str(product))}
        if row["name_differs"]:
            notes.append(f"The file says '{details}'; this is '{product}'"
                         + (" (the same name, with the size word written short)" if by_size_word and "product" not in edit else "")
                         + ". Check it is the same product.")
        if not product.is_active:
            problem(f"{product} is switched off.", "Switch it back on in Products if it is being sold again, or exclude the row.")
        # A plain unit word ("bottle", "CRET") for the product's own unit needs no explanation; a pack such as BOX(24) does.
        if values["unit"] and _is_own_pack(product, values["unit"]) and (unit is None or per_pack or unit != product.base_unit):
            # Its own recorded pack: counted in the product's own unit, one for one.
            unit, per_pack = product.base_unit, None
            row["unit_name"] = unit
            notes.append(f"'{values['unit']}' is how {product} is packed (recorded on the product), so the quantity is "
                         f"taken as {product.base_unit.lower()}s.")
        elif values["unit"] and unit is None:
            problem(f"'{values['unit']}' is not one of the units the shop uses"
                    + (f", and it is not the pack recorded for {product} ('{product.pack_description}')" if product.pack_description else "")
                    + ".", f"In Review, choose the unit ({product.base_unit} for this product) and the quantity in it.")
        elif per_pack and unit != product.base_unit and _factor(product, unit) is None:
            problem(f"'{values['unit']}' is a pack, but {product} has "
                    + (f"a different pack recorded ('{product.pack_description}')" if product.pack_description else "no pack recorded")
                    + f" and no verified {unit.lower()} package.",
                    f"In Review, change the unit to {product.base_unit} and enter how many {product.base_unit.lower()}s came in, "
                    "or exclude the row.")
            unit = None
        if unit is not None:
            factor = _factor(product, unit)
            if per_pack and factor is not None and factor != 1 and factor != per_pack:
                problem(f"The file says {unit.lower()}es of {per_pack}; the verified {unit.lower()} of {product} holds {factor.normalize()}.",
                        "Correct the unit or quantity in Review.")
            if factor is None:
                packages = [u.name.lower() for u in product.units.all() if u.is_active and u.is_verified]
                problem(f"{product} is counted in {product.base_unit.lower()}s"
                        + (f" (also sold by the {', '.join(packages)})" if packages else "")
                        + f", not by the {unit.lower()}.",
                        f"Change the unit to {product.base_unit} and the quantity to match, or have a {unit.lower()} "
                        "package set up and verified for it (Products → Details).")
            else:
                row["factor"] = factor
                if quantity is not None:
                    adds = quantity * factor
                    if adds != adds.to_integral_value():
                        problem(f"{quantity} {unit.lower()}(s) is {adds.normalize()} {product.base_unit.lower()}s, not a whole number.",
                                f"Change the quantity to {product.base_unit.lower()}s.")
                    else:
                        row["adds"] = adds
                if factor != 1:
                    notes.append(f"1 {unit.lower()} = {factor.normalize()} {product.base_unit.lower()}s (the verified package).")
        if volume is not None:
            if product.volume_ml is None:
                notes.append(f"The product has no volume recorded, so {volume} ml could not be checked.")
            elif product.volume_ml != volume:
                problem(f"The file says {volume} ml; {product} is {product.volume_ml} ml.",
                        "Correct the volume, or choose the right product.")

    if product is None and values["unit"] and unit is None:
        problem(f"'{values['unit']}' is not one of the units the shop uses.", f"Choose one of: {', '.join(SoldBy.values)}.")
    if row["status"] is None:
        row["status"] = INVALID if problems else READY
    if row["excluded"]:
        row["status"] = EXCLUDED
    return row


# What the Owner sees in the Match Status column.
MATCH_LABELS = {"MATCHED": "Matched", "DUPLICATE": "Duplicate", "NEEDS_REVIEW": "Needs review", "UNMATCHED": "Unmatched",
                "EXCLUDED": "Excluded", "SKIPPED": "Not a product row"}
BLOCKING = {AMBIGUOUS, UNMATCHED, INVALID}


def _match_status(r: dict) -> str:
    if r["status"] in (EXCLUDED, SKIPPED, UNMATCHED):
        return r["status"]
    if r["status"] in BLOCKING:
        return "NEEDS_REVIEW"
    return "DUPLICATE" if r["duplicate"] else "MATCHED"


def analyse(rows: list[dict], edits: dict | None = None, decisions: dict | None = None) -> dict:
    """Every row checked and matched, in the Products page's S/No order (rows with no product last, in file order).

    `edits` are the Owner's corrections by Excel row number: product, unit, volume, quantity, excluded.
    `decisions` say, for a product on several rows, whether to "combine" them or keep them "separate".
    """
    catalogue = _Catalogue()
    edits = {str(k): v for k, v in (edits or {}).items()}
    decisions = {str(k): v for k, v in (decisions or {}).items()}
    checked = [_check_row(raw, catalogue, edits.get(str(raw["row"]), {})) for raw in rows]

    # The same product on more than one row: shown, never dropped. The Owner says whether to combine them.
    groups = defaultdict(list)
    for r in checked:
        if r["status"] in (EXCLUDED, SKIPPED):
            continue
        if r["product"]:
            groups[("product", r["product"]["id"])].append(r)
        elif r["details"]:
            groups[("text", normalise_name(r["details"]), r["unit"].lower(), r["volume"])].append(r)
    duplicates = []
    for key, members in groups.items():
        if len(members) > 1:
            for r in members:
                r["duplicate"] = True
            if key[0] == "product":
                ready = [r for r in members if r["status"] == READY]
                duplicates.append({"product": key[1], "label": members[0]["product"]["label"], "rows": [r["row"] for r in members],
                                   "ready_rows": [r["row"] for r in ready], "total": sum((r["adds"] for r in ready), ZERO),
                                   "decision": decisions.get(str(key[1]))})

    # Projected stock: what the product has now plus every row for it that will be imported.
    adding = defaultdict(lambda: ZERO)
    for r in checked:
        if r["status"] == READY:
            adding[r["product"]["id"]] += r["adds"]
    for r in checked:
        if r["product"]:
            r["stock_after"] = r["stock_before"] + adding[r["product"]["id"]]
        r["status_label"] = STATUS_LABELS[r["status"]]
        r["match_status"] = _match_status(r)
        r["match_label"] = MATCH_LABELS[r["match_status"]]

    def order(r):
        p = r["product"]
        return (0, p["serial_number"] or 10**9, p["label"].lower(), r["row"]) if p else (1, 0, "", r["row"])

    checked.sort(key=order)
    counts = {s: sum(1 for r in checked if r["status"] == s) for s in STATUS_LABELS}
    undecided = [d for d in duplicates if len(d["ready_rows"]) > 1 and d["decision"] not in ("combine", "separate")]
    # What will go into stock, per unit it is counted in. Different units are never added together.
    totals = defaultdict(lambda: ZERO)
    for r in checked:
        if r["status"] == READY:
            totals[r["product"]["base_unit"]] += r["adds"]
    blocking = sum(1 for r in checked if r["status"] in BLOCKING)
    summary = {
        "total_rows": len(checked),
        "matched": sum(1 for r in checked if r["match_status"] in ("MATCHED", "DUPLICATE")),
        "needs_review": sum(1 for r in checked if r["match_status"] == "NEEDS_REVIEW"),
        "unmatched": counts[UNMATCHED],
        "duplicate_rows": sum(1 for r in checked if r["duplicate"]),
        "ready": counts[READY], "excluded": counts[EXCLUDED], "not_product_rows": counts[SKIPPED],
        "blocking": blocking, "undecided_duplicates": len(undecided),
        "received_by_unit": [{"unit": u, "quantity": q} for u, q in sorted(totals.items())],
        "products_ready": len(adding),
    }
    summary["can_confirm"] = blocking == 0 and not undecided and counts[READY] > 0
    return {"rows": checked, "counts": counts, "duplicates": duplicates, "products_ready": len(adding), "summary": summary}


# --- 3. Confirming ---------------------------------------------------------------------------------

def _plan(rows: list[dict], decisions: dict) -> list[list[dict]]:
    """Ready rows as stock receipts. A product may appear only once in a receipt, so rows kept separate go into a
    second (third…) receipt of the same import; combined rows become one line with the quantities added up."""
    by_product = defaultdict(list)
    for r in sorted((r for r in rows if r["status"] == READY), key=lambda r: r["row"]):
        by_product[r["product"]["id"]].append(r)
    receipts = defaultdict(list)
    undecided = []
    for pk, members in by_product.items():
        if len(members) == 1:
            receipts[0].append({"product": pk, "rows": members})
            continue
        choice = decisions.get(str(pk))
        if choice == "combine":
            receipts[0].append({"product": pk, "rows": members})
        elif choice == "separate":
            for i, r in enumerate(members):
                receipts[i].append({"product": pk, "rows": [r]})
        else:
            undecided.append(f"{members[0]['product']['label']} (rows {', '.join(str(r['row']) for r in members)})")
    if undecided:
        raise BusinessRuleError("These products are on more than one row. Choose whether to add the rows together as one "
                                f"delivery or keep them as separate deliveries: {'; '.join(undecided)}.",
                                code="duplicates_undecided", status_code=400)
    return [receipts[i] for i in sorted(receipts)]


def previous_import(batch: ReceiptImport):
    return (ReceiptImport.objects.filter(branch=batch.branch, file_hash=batch.file_hash, status=ReceiptImport.Status.CONFIRMED)
            .exclude(pk=batch.pk).select_related("confirmed_by").order_by("-confirmed_at").first())


def _clean_edits(edits: dict, rows: list[dict]) -> dict:
    """Only real corrections to rows that exist: a value the same as the file's is dropped."""
    by_row = {str(r["row"]): r for r in rows}
    clean = {}
    for key, edit in (edits or {}).items():
        raw = by_row.get(str(key))
        if raw is None or not isinstance(edit, dict):
            raise BusinessRuleError(f"There is no Excel row {key} in this file.", code="bad_edit", status_code=400)
        kept = {}
        if edit.get("product") not in (None, ""):
            try:
                kept["product"] = int(edit["product"])
            except (TypeError, ValueError):
                raise BusinessRuleError(f"Row {key}: choose the product from the list.", code="bad_edit", status_code=400)
        for field, limit in (("unit", 30), ("volume", 20), ("quantity", 20)):
            if field in edit and edit[field] is not None and str(edit[field]).strip() != raw[field]:
                kept[field] = str(edit[field]).strip()[:limit]
        if edit.get("excluded"):
            kept["excluded"] = True
        if kept:
            clean[str(key)] = kept
    return clean


def save_review(*, batch_id, user, edits=None, decisions=None) -> ReceiptImport:
    """Keep the Owner's corrections and combine/separate choices on the upload. Stock is not touched."""
    with transaction.atomic():
        batch = ReceiptImport.objects.select_for_update().filter(pk=batch_id, branch=get_branch()).first()
        if batch is None:
            raise BusinessRuleError("We could not find that upload. Upload the file again.", code="not_found", status_code=404)
        if batch.status == ReceiptImport.Status.CONFIRMED:
            raise BusinessRuleError("This upload has already been imported; it can no longer be changed.", code="already_confirmed", status_code=409)
        if edits is not None:
            batch.edits = _clean_edits(edits, batch.rows)
        if decisions is not None:
            batch.decisions = {str(k): v for k, v in decisions.items() if v in ("combine", "separate")}
        batch.save(update_fields=["edits", "decisions"])
        return batch


def confirm(*, batch_id, user, supplier=None, reference="", note="", reimport_reason=""):
    """Add the ready rows to stock, all or nothing, once every row is ready, excluded or not a product row.
    Confirming the same batch again changes nothing."""
    branch = get_branch()
    with transaction.atomic():
        batch = ReceiptImport.objects.select_for_update().filter(pk=batch_id, branch=branch).first()
        if batch is None:
            raise BusinessRuleError("We could not find that upload. Upload the file again.", code="not_found", status_code=404)
        if batch.status == ReceiptImport.Status.CONFIRMED:
            return batch, False
        if not get_settings(branch).is_live:
            raise BusinessRuleError("Stock can be received after the shop goes live.", code="not_live")

        earlier = previous_import(batch)
        reimport_reason = (reimport_reason or "").strip()
        if earlier:
            when = timezone.localtime(earlier.confirmed_at).strftime("%d %b %Y %H:%M")
            if len(reimport_reason) < 10:
                raise BusinessRuleError(f"This file was already imported on {when} by {earlier.confirmed_by.display_name}, "
                                        "so its stock is already in. To add it a second time, write why (at least 10 characters).",
                                        code="already_imported", status_code=400,
                                        details={"batch": str(earlier.pk), "imported_at": earlier.confirmed_at})

        analysis = analyse(batch.rows, batch.edits, batch.decisions)
        open_rows = [r for r in analysis["rows"] if r["status"] in BLOCKING]
        if open_rows:
            raise BusinessRuleError(
                f"{len(open_rows)} row(s) still need attention (Excel rows {', '.join(str(r['row']) for r in sorted(open_rows, key=lambda r: r['row']))}). "
                "Correct each one or exclude it, then confirm.", code="unresolved_rows", status_code=400)
        plan = _plan(analysis["rows"], batch.decisions)
        if not plan:
            raise BusinessRuleError("No row is ready to add to stock. Correct the file and upload it again.", code="nothing_ready", status_code=400)

        products = {p.pk: p for p in Product.objects.filter(pk__in={e["product"] for r in plan for e in r})}
        text = f"Uploaded file '{batch.file_name}', import {str(batch.pk)[:8]}"
        receipts, row_receipt = [], {}
        for index, entries in enumerate(plan):
            lines = [{"product": products[e["product"]], "quantity": sum((r["adds"] for r in e["rows"]), ZERO),
                      # The product's purchase price, as the Receive Stock screen fills in; the file has no cost column.
                      "unit_cost": products[e["product"]].cost_price} for e in entries]
            receipt, _ = receive_stock(user=user, request_key=uuid.uuid5(batch.pk, str(index)), lines=lines, supplier=supplier,
                                       reference=reference, note=(f"{note.strip()} · {text}" if note.strip() else text)[:300])
            receipts.append(receipt)
            for e in entries:
                for r in e["rows"]:
                    row_receipt[r["row"]] = receipt.pk

        rows = analysis["rows"]
        added = [r for r in rows if r["row"] in row_receipt]
        result = {
            "batch": str(batch.pk), "file": batch.file_name, "receipts": [r.pk for r in receipts],
            "rows_added": len(added), "products_updated": len({r["product"]["id"] for r in added}),
            "added": [{"row": r["row"], "details": r["details"], "unit": r["unit"], "volume": r["volume"], "quantity": r["quantity"],
                       "product": r["product"]["label"], "added": str(r["adds"]), "base_unit": r["product"]["base_unit"],
                       "receipt": row_receipt[r["row"]]} for r in added],
            "corrected": {row: edit for row, edit in batch.edits.items() if not edit.get("excluded")},
            "skipped": [{"row": r["row"], "details": r["details"], "status": r["status_label"],
                         "problems": [p["problem"] for p in r["problems"]] or r["notes"]}
                        for r in rows if r["row"] not in row_receipt],
        }
        batch.status, batch.confirmed_by, batch.confirmed_at = ReceiptImport.Status.CONFIRMED, user, timezone.now()
        batch.result, batch.reimport_reason = result, reimport_reason[:300]
        batch.save()
        batch.receipts.set(receipts)
        audit(user, "stock.receipt_import_reprocessed" if earlier else "stock.receipt_imported", batch, reason=reimport_reason,
              summary=f"Imported '{batch.file_name}': {result['rows_added']} row(s), {result['products_updated']} product(s), "
                      f"{len(result['skipped'])} skipped",
              after={"batch": str(batch.pk), "file": batch.file_name, "file_hash": batch.file_hash, "receipts": result["receipts"],
                     "products": {str(r["product"]["id"]): str(r["adds"]) for r in added},
                     "skipped_rows": [s["row"] for s in result["skipped"]],
                     "excluded_rows": sorted(int(k) for k, e in batch.edits.items() if e.get("excluded")),
                     "corrections": batch.edits, "duplicates": batch.decisions,
                     "earlier_import": str(earlier.pk) if earlier else None})
        return batch, True
