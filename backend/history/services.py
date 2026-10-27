"""Importing historical daily sheets and reviewing what they contain.

Safeguards kept throughout:
- a dry run never writes anything;
- every stored line carries its worksheet and row and its original cell text;
- stable source keys make a repeated import add nothing;
- nothing here touches sales, payments, stock movements or balances.
"""
from collections import defaultdict
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from core.errors import BusinessRuleError
from core.services import audit, money

from . import analysis
from .analysis import plain
from .models import (ApprovedPrice, HistoricalRecord, HistoryAcceptance, ImportBatch, ReviewItem, ReviewNote, ReviewStatus,
                     SourceProduct, UnclassifiedRow, UnclassifiedRowDecision)
from .parser import NUMERIC_FIELDS

P, A, R = ReviewStatus.PENDING_REVIEW, ReviewStatus.APPROVED, ReviewStatus.REJECTED
# Exceptions the analysis re-derives from the stored records each time; the others come from a particular file.
DERIVED_KINDS = ["MISSING_DATES", "CARRY_FORWARD_BREAK", "SAME_NAME_DIFFERENT_PRICE", "PRICE_ANOMALY", "MISSING_PRICE",
                 "ARITHMETIC", "INVALID_VALUES"]
OWNER_ONLY_KINDS = {"SAME_NAME_DIFFERENT_PRICE", "PRICE_ANOMALY", "MISSING_PRICE"}
GENERAL = {"EXPLAINED": A, "ACCEPTED_INCOMPLETE": A, "REJECTED_RECORDS": R}
RESOLUTIONS = {
    "SAME_NAME_DIFFERENT_PRICE": {"SAME_PRODUCT_PRICE_CHANGE": A, "DIFFERENT_VARIANTS": A, "DIFFERENT_PRICE_TYPES": A, "DATA_ENTRY_ERROR": A},
    "PRICE_ANOMALY": {"CONFIRMED_CORRECT": A, "DATA_ENTRY_ERROR": A, "DIFFERENT_PRICE_TYPE": A, "OTHER": A},
    "MISSING_PRICE": {"PRICE_APPROVED": A, "NOT_FOR_SALE": A},
}
RESOLUTION_LABELS = {
    "EXPLAINED": "Explained with evidence", "ACCEPTED_INCOMPLETE": "Accepted as incomplete (not verified)",
    "REJECTED_RECORDS": "Records rejected", "SAME_PRODUCT_PRICE_CHANGE": "Same product; a legitimate price change",
    "DIFFERENT_VARIANTS": "Different package sizes or variants", "DIFFERENT_PRICE_TYPES": "Different price types",
    "DATA_ENTRY_ERROR": "Data-entry error", "CONFIRMED_CORRECT": "The recorded value is correct",
    "DIFFERENT_PRICE_TYPE": "The column holds a different price type", "OTHER": "Other (see note)",
    "PRICE_APPROVED": "Selling price approved", "NOT_FOR_SALE": "Not sold; keep the history only",
    "NO_LONGER_APPLIES": "No longer applies after supplementary records were imported",
}


def _bad(message, code, details=None):
    return BusinessRuleError(message, code=code, status_code=400, details=details)


# --- Turning a parsed workbook into rows ----------------------------------------------------

def _rows_from(parsed: dict):
    rows, others, sheets = [], [], []
    for sheet in parsed["sheets"]:
        info = {"worksheet": sheet["name"], "date": sheet["date"], "error": sheet["error"],
                "product_rows": len(sheet["products"]), "other_rows": len(sheet["other_rows"])}
        sheets.append(info)
        if sheet["error"]:
            continue
        sums = defaultdict(Decimal)
        seen = set()
        for product in sheet["products"]:
            key = f"{sheet['date']}|{product['serial']}|{product['normalised']}"
            errors = list(product["errors"])
            if key in seen:  # the same S/N and name twice in one sheet: keep both, flag the second
                key += f"|row {product['row']}"
                errors.append("The same S/N and name appear more than once in this sheet.")
            seen.add(key)
            row = {"key": key, "sp_key": f"{product['serial']}|{product['normalised']}", "date": sheet["date"],
                   "serial": product["serial"], "norm": product["normalised"], "name": product["name"], "pack": product["pack"],
                   "description": product["description"], "worksheet": sheet["name"], "row": product["row"],
                   "original": product["original"], "errors": errors, **{f: product[f] for f in NUMERIC_FIELDS}}
            row["validation_status"], row["validation_messages"] = analysis.validate_record(row)
            rows.append(row)
            for field in NUMERIC_FIELDS:
                sums[field] += product[field] or 0
        info.update(units_sold=sums["sold_qty"], total_sales=sums["total_sales"], headings=sheet["headings"])
        for other in sheet["other_rows"]:
            figures, matched = [], []
            for cell in other["cells"]:
                try:
                    value = Decimal(cell["value"].replace(",", ""))
                except ArithmeticError:
                    continue
                if value == 0:
                    continue
                figures.append(value)
                matched += [sheet["headings"].get(f, f) for f in NUMERIC_FIELDS if sums[f] == value][:1]
            # A proposal is only a suggestion with its evidence. A reviewer decides; nothing is applied automatically.
            if figures and len(matched) == len(figures):
                proposal, basis = "Column totals", "Every figure equals the sum of a column: " + ", ".join(sorted(set(matched)))
            elif matched:
                proposal, basis = "Partly column totals", "Some figures equal the sum of a column: " + ", ".join(sorted(set(matched)))
            else:
                proposal, basis = "Not known", "The figures match no column total and the row has no label."
            others.append({"key": f"{sheet['date']}|row {other['row']}", "date": sheet["date"], "worksheet": sheet["name"],
                           "row": other["row"], "cells": other["cells"], "proposal": proposal, "basis": basis})
    return rows, others, sheets


def _stored_rows() -> list[dict]:
    """Every stored record (except rejected ones) in the shape the analysis expects."""
    fields = ["source_key", "business_date", "worksheet", "source_row", "validation_status", "validation_messages",
              "source_product__serial_number", "source_product__normalised_name", "source_product__source_name",
              "source_product__source_key", *NUMERIC_FIELDS]
    return [
        {"key": r["source_key"], "date": r["business_date"], "worksheet": r["worksheet"], "row": r["source_row"],
         "serial": r["source_product__serial_number"], "norm": r["source_product__normalised_name"],
         "name": r["source_product__source_name"], "sp_key": r["source_product__source_key"],
         "validation_status": r["validation_status"], "validation_messages": r["validation_messages"],
         **{f: r[f] for f in NUMERIC_FIELDS}}
        for r in HistoricalRecord.objects.exclude(import_status=R).values(*fields)
    ]


def _same_values(row: dict, stored: dict) -> bool:
    return all((row[f] is None and stored[f] is None) or (row[f] is not None and stored[f] is not None and row[f] == stored[f])
               for f in NUMERIC_FIELDS)


def build_plan(parsed: dict, digest: str) -> dict:
    """Works out exactly what an import would do. Reads the database; writes nothing."""
    rows, others, sheets = _rows_from(parsed)
    stored = {r["source_key"]: r for r in HistoricalRecord.objects.filter(source_key__in=[r["key"] for r in rows])
              .values("source_key", "worksheet", "source_row", "source_file", *NUMERIC_FIELDS)}
    new, duplicates, conflicts = [], [], []
    for row in rows:
        if row["key"] not in stored:
            new.append(row)
        elif _same_values(row, stored[row["key"]]):
            duplicates.append(row)
        else:
            conflicts.append((row, stored[row["key"]]))
    known_other = set(UnclassifiedRow.objects.filter(source_key__in=[o["key"] for o in others]).values_list("source_key", flat=True))
    new_others = [o for o in others if o["key"] not in known_other]

    issues = analysis.analyse(_stored_rows() + new)
    for sheet in sheets:
        if sheet["error"]:
            issues.append({"key": f"UNREADABLE_SHEET|{digest[:12]}|{sheet['worksheet']}", "kind": "UNREADABLE_SHEET", "severity": "MATERIAL",
                           "title": f"Sheet “{sheet['worksheet']}” was not read", "details": {"reason": sheet["error"], "file": parsed["filename"]},
                           "date_from": None, "date_to": None, "sp_keys": [], "record_keys": []})
    by_day = defaultdict(list)
    for row, old in conflicts:
        by_day[row["date"]].append({
            "product": row["name"], "already_stored": {"file": old["source_file"], "worksheet": old["worksheet"], "row": old["source_row"],
                                                       **{f: plain(old[f]) for f in NUMERIC_FIELDS}},
            "in_this_file": {"worksheet": row["worksheet"], "row": row["row"], **{f: plain(row[f]) for f in NUMERIC_FIELDS}}, "key": row["key"]})
    for day, lines in by_day.items():
        issues.append({"key": f"DUPLICATE_CONFLICT|{day}|{digest[:12]}", "kind": "DUPLICATE_CONFLICT", "severity": "MATERIAL",
                       "title": f"{len(lines)} line(s) for {day:%d %b %Y} are already stored with different values",
                       "details": {"lines": lines, "file": parsed["filename"],
                                   "statement": "The stored records were kept. The differing lines in this file were not imported."},
                       "date_from": day, "date_to": day, "sp_keys": [], "record_keys": [line["key"] for line in lines]})
    existing_keys = set(ReviewItem.objects.filter(key__in=[i["key"] for i in issues]).values_list("key", flat=True))
    for issue in issues:
        issue["is_new"] = issue["key"] not in existing_keys

    known_products = set(SourceProduct.objects.filter(source_key__in={r["sp_key"] for r in rows}).values_list("source_key", flat=True))
    readable = [s for s in sheets if not s["error"]]
    dates = sorted(s["date"] for s in readable)
    return {
        "filename": parsed["filename"], "digest": digest, "rows": rows, "new": new, "duplicates": duplicates, "conflicts": conflicts,
        "others": others, "new_others": new_others, "sheets": sheets, "issues": issues,
        "summary": {
            "file": parsed["filename"],
            "already_imported_file": ImportBatch.objects.filter(file_sha256=digest).exists(),
            "worksheets": len(sheets), "worksheets_read": len(readable), "worksheets_not_read": len(sheets) - len(readable),
            "date_from": dates[0] if dates else None, "date_to": dates[-1] if dates else None,
            "product_rows": len(rows), "accepted_new": len(new), "duplicates_skipped": len(duplicates),
            "conflicts_not_imported": len(conflicts),
            "rows_with_errors": sum(1 for r in rows if r["validation_status"] == "ERROR"),
            "rows_with_warnings": sum(1 for r in rows if r["validation_status"] == "WARNING"),
            "unlabelled_rows": len(others), "unlabelled_rows_new": len(new_others),
            "source_products": len({r["sp_key"] for r in rows}),
            "source_products_new": len({r["sp_key"] for r in rows} - known_products),
            "exceptions": len(issues), "exceptions_new": sum(1 for i in issues if i["is_new"]),
            "material_exceptions": sum(1 for i in issues if i["severity"] == "MATERIAL"),
            "workbook_total_sales": plain(sum((s.get("total_sales") or 0 for s in readable), Decimal("0"))),
            "workbook_units_sold": plain(sum((s.get("units_sold") or 0 for s in readable), Decimal("0"))),
        },
    }


def describe_plan(plan: dict) -> dict:
    """The dry-run preview shown to the reviewer."""
    return {
        "summary": plain(plan["summary"]),
        "worksheets": [plain({k: s.get(k) for k in ("worksheet", "date", "error", "product_rows", "other_rows", "units_sold", "total_sales")})
                       for s in plan["sheets"]],
        "exceptions": [{"key": i["key"], "kind": i["kind"], "severity": i["severity"], "title": i["title"], "is_new": i["is_new"],
                        "records_affected": len(i["record_keys"])} for i in plan["issues"]],
        "row_problems": [{"worksheet": r["worksheet"], "row": r["row"], "product": r["name"], "status": r["validation_status"],
                          "problems": r["validation_messages"]} for r in plan["rows"] if r["validation_status"] != "VALID"][:300],
        "statement": "This is a preview. Nothing has been saved, and live stock and sales are never changed by a historical import.",
    }


# --- Committing ----------------------------------------------------------------------------

@transaction.atomic
def commit_plan(plan: dict, user) -> ImportBatch:
    batch = ImportBatch.objects.create(
        filename=plan["filename"], file_sha256=plan["digest"], imported_by=user, summary=plain(plan["summary"]),
        is_supplementary=HistoricalRecord.objects.exists(),
    )
    products = {p.source_key: p for p in SourceProduct.objects.filter(source_key__in={r["sp_key"] for r in plan["new"]})}
    for row in plan["new"]:
        if row["sp_key"] not in products:
            products[row["sp_key"]] = SourceProduct.objects.create(
                source_key=row["sp_key"], serial_number=row["serial"], source_name=row["name"], normalised_name=row["norm"])
    HistoricalRecord.objects.bulk_create([
        HistoricalRecord(
            batch=batch, source_key=row["key"], source_file=plan["filename"], worksheet=row["worksheet"], source_row=row["row"],
            business_date=row["date"], source_product=products[row["sp_key"]], original=row["original"],
            validation_status=row["validation_status"], validation_messages=row["validation_messages"],
            **{f: row[f] for f in NUMERIC_FIELDS})
        for row in plan["new"]], batch_size=500)
    UnclassifiedRow.objects.bulk_create([
        UnclassifiedRow(batch=batch, source_key=o["key"], source_file=plan["filename"], worksheet=o["worksheet"], source_row=o["row"],
                        business_date=o["date"], original=o["cells"], proposed_classification=o["proposal"], proposal_basis=o["basis"])
        for o in plan["new_others"]], batch_size=500)

    # Pack / size text is taken from wherever the sheet states it.
    latest_text = {}
    for row in sorted(plan["new"], key=lambda r: r["date"]):
        if row["pack"] or row["description"]:
            latest_text[row["sp_key"]] = (row["pack"], row["description"])
    for key, (pack, description) in latest_text.items():
        SourceProduct.objects.filter(source_key=key).update(pack_text=pack[:80], description_text=description[:80])

    file_issues = [i for i in plan["issues"] if i["kind"] not in DERIVED_KINDS]
    sync_review_items(batch, user, file_issues)
    refresh_source_products()

    stored = HistoricalRecord.objects.filter(batch=batch).count()
    batch.summary = {**batch.summary, "records_stored": stored, "verified_against_workbook": stored == len(plan["new"])}
    batch.save(update_fields=["summary"])
    audit(user, "history.imported", batch, summary=f"Imported historical workbook '{batch.filename}': {stored} new records, "
          f"{len(plan['duplicates'])} already stored, {len(plan['conflicts'])} conflicting", after=batch.summary)
    return batch


def sync_review_items(batch, user, file_issues=()):
    """Bring the list of exceptions in line with the records now stored. Decisions already made are never undone."""
    issues = analysis.analyse(_stored_rows()) + list(file_issues)
    record_ids = dict(HistoricalRecord.objects.values_list("source_key", "id"))
    product_ids = dict(SourceProduct.objects.values_list("source_key", "id"))
    existing = {i.key: i for i in ReviewItem.objects.all()}
    for issue in issues:
        item = existing.get(issue["key"])
        if item is None:
            item = ReviewItem.objects.create(
                key=issue["key"], kind=issue["kind"], severity=issue["severity"], title=issue["title"][:255],
                details=plain(issue["details"]), date_from=issue["date_from"], date_to=issue["date_to"], batch=batch)
        elif item.status == P:
            item.title, item.details, item.severity = issue["title"][:255], plain(issue["details"]), issue["severity"]
            item.date_from, item.date_to = issue["date_from"], issue["date_to"]
            item.save(update_fields=["title", "details", "severity", "date_from", "date_to"])
        else:
            continue  # decided already: the decision and what it was based on stay as they are
        item.records.set([record_ids[k] for k in issue["record_keys"] if k in record_ids])
        item.source_products.set([product_ids[k] for k in issue["sp_keys"] if k in product_ids])

    current = {i["key"] for i in issues}
    for item in ReviewItem.objects.filter(status=P, kind__in=DERIVED_KINDS).exclude(key__in=current):
        item.status, item.resolution = A, "NO_LONGER_APPLIES"
        item.note = f"Closed automatically: after importing '{batch.filename}' the stored records no longer show this exception."
        item.decided_by, item.decided_at = user, timezone.now()
        item.save()
        audit(user, "history.exception_closed", item, summary=f"Exception no longer applies: {item.title}"[:255], reason=item.note)
    refresh_record_statuses()


def refresh_record_statuses(record_ids=None):
    """A record is incomplete while any exception touching it is undecided, rejected, or accepted without explanation."""
    links = ReviewItem.records.through.objects.select_related("reviewitem")
    if record_ids is not None:
        links = links.filter(historicalrecord_id__in=record_ids)
    by_record = defaultdict(list)
    for link in links:
        by_record[link.historicalrecord_id].append(link.reviewitem)
    groups = defaultdict(list)
    for record_id, items in by_record.items():
        material = [i for i in items if i.severity == "MATERIAL"]
        if any(i.status == P for i in material):
            state = (P, True)
        elif any(i.status == R for i in material):
            state = (R, True)
        elif material:
            state = (A, any(i.resolution == "ACCEPTED_INCOMPLETE" for i in material))
        else:
            state = (ReviewStatus.IMPORTED, False)
        groups[state].append(record_id)
    for (status, incomplete), ids in groups.items():
        HistoricalRecord.objects.filter(pk__in=ids).update(import_status=status, incomplete=incomplete)


def refresh_source_products():
    """Recalculate what each source product's lines show (dates, price history, flags, proposals)."""
    rows_by_key, names_by_serial, text_by_serial = defaultdict(list), defaultdict(set), {}
    for row in _stored_rows():
        rows_by_key[row["sp_key"]].append(row)
        names_by_serial[row["serial"]].add(row["norm"])
    products = list(SourceProduct.objects.all())
    for product in sorted(products, key=lambda p: p.last_seen or p.first_seen or timezone.now().date()):
        if product.pack_text or product.description_text:
            text_by_serial[product.serial_number] = (product.pack_text, product.description_text)
    for product in products:
        rows = rows_by_key.get(product.source_key, [])
        pack, size = text_by_serial.get(product.serial_number, ("", ""))
        product.first_seen = min((r["date"] for r in rows), default=product.first_seen)
        product.last_seen = max((r["date"] for r in rows), default=product.last_seen)
        product.record_count = len(rows)
        product.selling_prices = analysis.price_history(rows, "sales_price")
        product.purchase_prices = analysis.price_history(rows, "purchase_price")
        product.flags = analysis.source_product_flags(rows, names_by_serial[product.serial_number], pack)
        product.proposed_name = product.source_name
        product.proposed_unit = analysis.propose_unit(pack)
        product.proposed_package_size = size[:40]
        product.save()


# --- Review decisions ----------------------------------------------------------------------

def _save_prices(item, source_product_ids, approved_prices, user, note):
    saved = []
    for entry in approved_prices or []:
        if entry["source_product"].pk not in source_product_ids:
            raise _bad("That price is for a product this exception does not concern.", "wrong_product")
        saved.append(ApprovedPrice.objects.create(
            source_product=entry["source_product"], price_type=entry["price_type"], amount=money(entry["amount"]),
            effective_date=entry["effective_date"], review_item=item, note=(entry.get("note") or note)[:500], approved_by=user))
    return saved


@transaction.atomic
def decide_item(*, user, item_id, resolution, note, evidence_reference="", approved_prices=None, identities=None):
    item = ReviewItem.objects.select_for_update().filter(pk=item_id).first()
    if item is None:
        raise BusinessRuleError("We could not find that exception.", code="not_found", status_code=404)
    if item.status != P:
        raise BusinessRuleError("This exception has already been decided. The Owner can reopen it to change the decision.", code="already_decided")
    if item.kind in OWNER_ONLY_KINDS and not user.is_owner:
        raise BusinessRuleError("Only the Owner can decide on product identity and prices. You can add a note for the Owner.",
                                code="owner_only", status_code=403)
    allowed = RESOLUTIONS.get(item.kind, GENERAL)
    if resolution not in allowed:
        raise _bad("Choose one of the listed decisions.", "bad_resolution", sorted(allowed))
    note, evidence_reference = (note or "").strip(), (evidence_reference or "").strip()
    if len(note) < 10:
        raise _bad("Write a note explaining the decision.", "note_required")
    if resolution == "EXPLAINED" and not evidence_reference:
        raise _bad("Say where the evidence is (for example a delivery note number or a page in the stock book).", "evidence_required")
    product_ids = set(item.source_products.values_list("pk", flat=True))
    approved_prices, identities = approved_prices or [], identities or []
    priced = {p["source_product"].pk for p in approved_prices}
    named = {e["source_product"].pk for e in identities if e.get("confirmed_name", "").strip()}
    sized = {e["source_product"].pk for e in identities if e.get("confirmed_package_size", "").strip()}
    with_unit = {e["source_product"].pk for e in identities if e.get("confirmed_unit", "").strip()}
    selling = [p for p in approved_prices if p["price_type"] == ApprovedPrice.PriceType.SELLING and p["amount"] > 0]
    # Mandatory confirmations (owner policy, 12 Oct 2026). An exception about identity or price cannot be closed
    # on a note alone: the Owner must state what the product is and which price, of which type, applies from when.
    if item.kind == "SAME_NAME_DIFFERENT_PRICE":
        if product_ids - (named & sized):
            raise _bad("For each line, confirm the product name and its package size.", "identity_required")
        if product_ids - priced:
            raise _bad("For each line, enter the approved price, say which price type it is, and the date it applies from.", "price_required")
    if item.kind == "PRICE_ANOMALY" and not approved_prices:
        raise _bad("Confirm which price type this figure is and the amount that applies, with the date it applies from. "
                   "The original values stay exactly as recorded.", "price_required")
    if resolution == "PRICE_APPROVED":
        if not selling:
            raise _bad("Enter the selling price being approved.", "price_required")
        if product_ids - (named & (with_unit | sized)):
            raise _bad("Confirm the product name and its unit or package size.", "identity_required")

    prices = _save_prices(item, product_ids, approved_prices, user, note)
    confirmed = []
    for entry in identities:
        product = entry["source_product"]
        if product.pk not in product_ids:
            raise _bad("That product is not part of this exception.", "wrong_product")
        product.confirmed_name = entry.get("confirmed_name", "").strip()[:200]
        product.confirmed_package_size = entry.get("confirmed_package_size", "").strip()[:40]
        product.confirmed_unit = entry.get("confirmed_unit", "").strip()[:30] or product.confirmed_unit
        product.save(update_fields=["confirmed_name", "confirmed_package_size", "confirmed_unit"])
        confirmed.append({"source_product": product.pk, "source_name": product.source_name, "confirmed_name": product.confirmed_name,
                          "confirmed_package_size": product.confirmed_package_size, "confirmed_unit": product.confirmed_unit})
    item.status, item.resolution, item.note, item.evidence_reference = allowed[resolution], resolution, note[:1000], evidence_reference[:300]
    item.decision = {"resolution_label": RESOLUTION_LABELS[resolution], "identities": confirmed,
                     "approved_prices": [{"source_product": p.source_product_id, "price_type": p.price_type, "amount": str(p.amount),
                                          "effective_date": str(p.effective_date)} for p in prices]}
    item.decided_by, item.decided_at = user, timezone.now()
    item.save()
    refresh_record_statuses(list(item.records.values_list("pk", flat=True)))
    audit(user, "history.exception_decided", item, reason=note, summary=f"{RESOLUTION_LABELS[resolution]}: {item.title}"[:255],
          before={"status": P}, after={"status": item.status, "resolution": resolution, "evidence": evidence_reference, **item.decision})
    return item


@transaction.atomic
def reopen_item(*, owner, item_id, reason):
    item = ReviewItem.objects.select_for_update().filter(pk=item_id).first()
    if item is None:
        raise BusinessRuleError("We could not find that exception.", code="not_found", status_code=404)
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise _bad("Write why the decision is being reopened.", "reason_required")
    if item.status == P:
        return item
    before = {"status": item.status, "resolution": item.resolution, "note": item.note, "decision": item.decision,
              "decided_by": getattr(item.decided_by, "username", "")}
    item.status, item.resolution, item.note, item.evidence_reference, item.decision = P, "", "", "", {}
    item.decided_by = item.decided_at = None
    item.save()
    refresh_record_statuses(list(item.records.values_list("pk", flat=True)))
    audit(owner, "history.exception_reopened", item, reason=reason, summary=f"Reopened: {item.title}"[:255], before=before, after={"status": P})
    return item


@transaction.atomic
def add_note(*, user, item_id, text, evidence_reference="", source_reference=""):
    item = ReviewItem.objects.filter(pk=item_id).first()
    if item is None:
        raise BusinessRuleError("We could not find that exception.", code="not_found", status_code=404)
    text = (text or "").strip()
    if len(text) < 5:
        raise _bad("Write the explanation.", "text_required")
    note = ReviewNote.objects.create(item=item, text=text[:1000], evidence_reference=evidence_reference.strip()[:300],
                                     source_reference=source_reference.strip()[:300], author=user)
    audit(user, "history.note_added", item, summary=f"Explanation added to: {item.title}"[:255], reason=text,
          after={"evidence": note.evidence_reference, "source": note.source_reference})
    return note


@transaction.atomic
def decide_rows(*, user, row_ids, action, classification="", reason=""):
    """Label, exclude or flag unlabelled rows. Whatever is chosen, a row is never imported as a transaction."""
    statuses = {"CLASSIFY": UnclassifiedRow.Status.APPROVED, "EXCLUDE": UnclassifiedRow.Status.REJECTED, "FLAG": UnclassifiedRow.Status.FLAGGED}
    if action not in statuses:
        raise _bad("Choose classify, exclude or flag.", "bad_action")
    classification, reason = (classification or "").strip(), (reason or "").strip()
    if action == "CLASSIFY" and not classification:
        raise _bad("Say what these rows are.", "classification_required")
    rows = list(UnclassifiedRow.objects.select_for_update().filter(pk__in=row_ids))
    if not rows:
        raise BusinessRuleError("We could not find those rows.", code="not_found", status_code=404)
    correcting = any(r.status != UnclassifiedRow.Status.PENDING_REVIEW for r in rows)
    if (action == "EXCLUDE" or correcting) and len(reason) < 5:
        raise _bad("A reason is needed to exclude rows or to change an earlier decision.", "reason_required")
    for row in rows:
        before = {"status": row.status, "classification": row.classification, "reason": row.reason}
        row.status, row.classification = statuses[action], classification[:80] if action == "CLASSIFY" else row.classification
        row.reason, row.decided_by, row.decided_at = reason[:500], user, timezone.now()
        row.save()
        # Every decision is kept, so the history of a row can always be read back.
        UnclassifiedRowDecision.objects.create(row=row, status=row.status, classification=row.classification, reason=row.reason, decided_by=user)
        audit(user, "history.row_decided", row, reason=reason,
              summary=f"{row.worksheet} row {row.source_row}: {row.get_status_display()}" + (f" as '{classification}'" if action == "CLASSIFY" else ""),
              before=before, after={"status": row.status, "classification": row.classification})
    return rows


@transaction.atomic
def decide_source_product(*, owner, source_product_id, approve, note="", confirmed_name="", confirmed_unit="",
                          confirmed_package_size="", product=None, create_product=False, selling_price=None, cost_price=None):
    """Owner's decision on one line of the Product Mapping Review."""
    import re

    from catalog.models import Product, SoldBy

    sp = SourceProduct.objects.select_for_update().filter(pk=source_product_id).first()
    if sp is None:
        raise BusinessRuleError("We could not find that source product.", code="not_found", status_code=404)
    note = (note or "").strip()
    before = {"status": sp.review_status, "product": sp.product_id, "confirmed_name": sp.confirmed_name}
    if not approve:
        if len(note) < 5:
            raise _bad("Write why this source product is not being mapped.", "note_required")
        sp.review_status, sp.product = R, None
    else:
        blocking = sp.review_items.filter(status=P, kind__in=["SAME_NAME_DIFFERENT_PRICE", "PRICE_ANOMALY"]).values_list("title", flat=True)
        if blocking:
            raise BusinessRuleError("Decide the open price question for this product first: " + "; ".join(blocking), code="open_exceptions")
        confirmed_name, confirmed_unit = (confirmed_name or "").strip(), (confirmed_unit or "").strip()
        if not confirmed_name or not confirmed_unit:
            raise _bad("Confirm the product name and the unit it is counted and sold in.", "identity_required")
        # The unit must be one of the approved selling units; free text is not accepted.
        approved_units = {unit.lower(): unit for unit in SoldBy.values}
        if confirmed_unit.lower() not in approved_units:
            raise _bad("Choose the unit from the list: " + ", ".join(SoldBy.values) + ".", "bad_unit")
        confirmed_unit = approved_units[confirmed_unit.lower()]
        if product is None and not create_product:
            raise _bad("Choose an existing product, or choose to create a new one.", "mapping_required")
        if create_product:
            price = money(selling_price) if selling_price is not None else Decimal("0.00")
            last = Product.objects.order_by("-id").values_list("id", flat=True).first() or 0
            size_text = (confirmed_package_size or "").strip()[:40]
            # A volume is recorded only when the Owner's confirmed size is plainly a number of millilitres.
            millilitres = re.fullmatch(r"(\d{1,5})\s*mls?\.?", size_text, re.IGNORECASE)
            # The product keeps the workbook's S/N as its S/No, unless another product already has that number.
            serial_free = sp.serial_number is not None and not Product.objects.filter(serial_number=sp.serial_number).exists()
            product = Product.objects.create(
                serial_number=sp.serial_number if serial_free else None,
                sku=f"P{last + 1:05d}", name=confirmed_name, package_size=size_text,
                volume_ml=int(millilitres.group(1)) if millilitres and int(millilitres.group(1)) > 0 else None,
                pack_description=sp.pack_text[:60], base_unit=confirmed_unit, selling_price=price,
                cost_price=None if cost_price is None else money(cost_price),
                # No approved selling price means the product exists but cannot be sold.
                is_active=price > 0,
            )
            audit(owner, "product.created", product, summary=f"Created from source product '{sp.source_name}'" + ("" if price > 0 else " (not on sale: no approved price)"),
                  after={"selling_price": price, "is_active": product.is_active})
            today = timezone.now().date()
            if price > 0:
                ApprovedPrice.objects.create(source_product=sp, price_type=ApprovedPrice.PriceType.SELLING, amount=price,
                                             effective_date=today, note=note or "Approved when mapping the product", approved_by=owner)
            if cost_price is not None:
                ApprovedPrice.objects.create(source_product=sp, price_type=ApprovedPrice.PriceType.PURCHASE_COST, amount=money(cost_price),
                                             effective_date=today, note=note or "Approved when mapping the product", approved_by=owner)
        sp.review_status, sp.product = A, product
        sp.confirmed_name, sp.confirmed_unit = confirmed_name[:200], confirmed_unit[:30]
        sp.confirmed_package_size = (confirmed_package_size or "").strip()[:40]
    sp.decision_note, sp.decided_by, sp.decided_at = note[:500], owner, timezone.now()
    sp.save()
    audit(owner, "history.mapping_decided", sp, reason=note,
          summary=f"Source product '{sp.source_name}' {'mapped to ' + str(sp.product) if approve else 'not mapped'}"[:255],
          before=before, after={"status": sp.review_status, "product": sp.product_id, "confirmed_name": sp.confirmed_name,
                                "confirmed_unit": sp.confirmed_unit})
    return sp


# --- Dashboard, reconciliation status, reference figures ------------------------------------

def dashboard() -> dict:
    from django.db.models import Count, Max, Min

    records = HistoricalRecord.objects.all()
    span = records.aggregate(first=Min("business_date"), last=Max("business_date"), days=Count("business_date", distinct=True))
    items = ReviewItem.objects.all()
    pending_material = items.filter(status=P, severity="MATERIAL")
    rows = UnclassifiedRow.objects.all()
    open_rows = rows.filter(status__in=[UnclassifiedRow.Status.PENDING_REVIEW, UnclassifiedRow.Status.FLAGGED])
    products = SourceProduct.objects.all()
    blockers = {"exceptions": pending_material.count(), "unlabelled_rows": open_rows.count(),
                "product_mappings": products.filter(review_status=P).count()}
    acceptance = HistoryAcceptance.objects.select_related("accepted_by").first()
    nothing_pending = not any(blockers.values())
    # An acceptance only covers what existed when it was given: any later import or decision needs a fresh one.
    stamps = [ImportBatch.objects.aggregate(t=Max("created_at"))["t"], items.aggregate(t=Max("decided_at"))["t"],
              rows.aggregate(t=Max("decided_at"))["t"], products.aggregate(t=Max("decided_at"))["t"]]
    latest_change = max((s for s in stamps if s), default=None)
    current = bool(acceptance) and (latest_change is None or acceptance.accepted_at >= latest_change)
    reconciled = current and nothing_pending and records.exists()
    missing = [d for i in items.filter(kind="MISSING_DATES") for d in i.details.get("missing_dates", [])]
    return {
        "has_data": records.exists(),
        "reconciled": reconciled,
        "statement": ("Accepted as reconciled by the Owner." if reconciled else
                      "No historical data has been imported." if not records.exists() else
                      "NOT RECONCILED. These historical figures are unverified and must not be relied on as reconciled."),
        "can_be_accepted": nothing_pending and records.exists() and not reconciled,
        "blockers": blockers,
        "acceptance": None if not acceptance else {"by": acceptance.accepted_by.display_name, "at": acceptance.accepted_at,
                                                   "note": acceptance.note, "still_valid": reconciled},
        "date_from": span["first"], "date_to": span["last"], "days_with_records": span["days"], "missing_dates": sorted(set(missing)),
        "records": {"total": records.count(), "incomplete": records.filter(incomplete=True).count(),
                    **{row["import_status"]: row["n"] for row in records.values("import_status").annotate(n=Count("id"))}},
        "validation": {row["validation_status"]: row["n"] for row in records.values("validation_status").annotate(n=Count("id"))},
        "exceptions": [{"kind": row["kind"], "label": ReviewItem.Kind(row["kind"]).label, "status": row["status"],
                        "severity": row["severity"], "count": row["n"]}
                       for row in items.values("kind", "status", "severity").annotate(n=Count("id")).order_by("kind", "status")],
        "source_products": {row["review_status"]: row["n"] for row in products.values("review_status").annotate(n=Count("id"))},
        "unlabelled_rows": {row["status"]: row["n"] for row in rows.values("status").annotate(n=Count("id"))},
        "imports": ImportBatch.objects.count(),
    }


@transaction.atomic
def accept_history(*, owner, note):
    state = dashboard()
    if not state["has_data"]:
        raise BusinessRuleError("There is no historical data to accept.", code="no_data")
    if any(state["blockers"].values()):
        raise BusinessRuleError(
            "The historical data cannot be accepted as reconciled while anything is still waiting for review.",
            code="still_pending", details=state["blockers"])
    note = (note or "").strip()
    if len(note) < 10:
        raise _bad("Write a note stating on what basis the historical data is accepted.", "note_required")
    acceptance = HistoryAcceptance.objects.create(note=note[:500], accepted_by=owner, snapshot=plain({
        "records": state["records"], "exceptions": state["exceptions"], "source_products": state["source_products"],
        "unlabelled_rows": state["unlabelled_rows"]}))
    audit(owner, "history.accepted", acceptance, reason=note, summary="Historical data accepted as reconciled", after=acceptance.snapshot)
    return acceptance


def reference_quantity(product):
    """The last recorded historical closing figure for a live product: shown beside a physical count, for comparison only."""
    record = (HistoricalRecord.objects.filter(source_product__product=product, source_product__review_status=A, closing_qty__isnull=False)
              .exclude(import_status=R).order_by("-business_date").first())
    if record is None:
        return None, ""
    return record.closing_qty, f"Excel closing stock on {record.business_date:%d %b %Y} (reference only)"


PRICE_QUESTION_KINDS = ["SAME_NAME_DIFFERENT_PRICE", "PRICE_ANOMALY", "MISSING_PRICE"]


def open_price_questions() -> int:
    """Price and identity questions still waiting for the Owner. Go-live is blocked while any remain."""
    return ReviewItem.objects.filter(status=P, kind__in=PRICE_QUESTION_KINDS).count()

# --- Adding the workbook's product list to the product table ---------------------------------

def products_from_latest_sheet(*, owner, commit: bool, units=None, sizes=None) -> dict:
    """Add the products listed on the latest imported sheet to the product table (owner's request, 13 Oct 2026).

    Only what the sheet itself states is used: the name as written, the unit where the sheet names one
    (bottle, crate, carton), the size from its description column, and that sheet's sales and purchase prices.
    Nothing is guessed: a line whose unit is not stated, or that has an open price question, is left for the Owner
    to decide in the Product Mapping Review, and is listed in the result. No stock is created; stock on hand
    still comes only from an approved opening count. Each product goes through the same step as a single
    mapping decision, so it is recorded and audited in the same way.

    `units` and `sizes` ({S/N: text}) carry the Owner's own answer for lines where the sheet does not say what one
    unit is (question X1, answered 14 Oct 2026). They never change a unit the sheet states.
    """
    units, sizes = units or {}, sizes or {}
    from django.db.models import Max

    from catalog.models import Product

    latest = HistoricalRecord.objects.aggregate(d=Max("business_date"))["d"]
    result = {"sheet": latest, "created": [], "mapped_to_existing": [], "left_for_owner": [], "already_done": 0, "committed": commit}
    if latest is None:
        return result
    note = f"Added from the Excel sheet of {latest:%d.%m.%Y} at the Owner's request"
    records = HistoricalRecord.objects.filter(business_date=latest).exclude(import_status=R).select_related("source_product").order_by("source_row")
    for record in records:
        sp = record.source_product
        row = {"serial": sp.serial_number, "name": sp.proposed_name or sp.source_name, "pack": sp.pack_text, "size": sp.proposed_package_size,
               "selling_price": record.sales_price, "purchase_price": record.purchase_price}
        if sp.product_id or sp.review_status != P:
            result["already_done"] += 1
            continue
        blocking = list(sp.review_items.filter(status=P, kind__in=["SAME_NAME_DIFFERENT_PRICE", "PRICE_ANOMALY"]).values_list("title", flat=True))
        same_name = list(Product.objects.filter(name__iexact=row["name"]))
        if blocking:
            result["left_for_owner"].append({**row, "why": "Open price question: " + "; ".join(blocking)})
            continue
        if same_name:
            match = same_name[0]
            # The same product only if the name and both prices agree; otherwise it is the Owner's call.
            if len(same_name) == 1 and match.selling_price == record.sales_price and match.cost_price == record.purchase_price:
                if commit:
                    decide_source_product(owner=owner, source_product_id=sp.pk, approve=True, note=note, confirmed_name=match.name,
                                          confirmed_unit=match.base_unit, confirmed_package_size=match.package_size, product=match)
                result["mapped_to_existing"].append({**row, "unit": match.base_unit, "product": match.pk})
            else:
                result["left_for_owner"].append({**row, "why": "A product with this name already exists with different prices"})
            continue
        unit, size, line_note = sp.proposed_unit, sp.proposed_package_size, note
        if not unit and sp.serial_number in units:
            unit, size = units[sp.serial_number], sizes.get(sp.serial_number, size)
            line_note = f"{note}; the Owner confirmed one unit is a {unit.lower()} (the sheet says '{sp.pack_text or 'nothing'}')"
            row["size"] = size
        if not unit:
            result["left_for_owner"].append({**row, "why": f"The sheet does not say what one unit is (it says '{sp.pack_text or 'nothing'}')"})
            continue
        if commit:
            decide_source_product(owner=owner, source_product_id=sp.pk, approve=True, note=line_note, confirmed_name=row["name"],
                                  confirmed_unit=unit, confirmed_package_size=size, create_product=True,
                                  selling_price=record.sales_price, cost_price=record.purchase_price)
        result["created"].append({**row, "unit": unit, "on_sale": bool(record.sales_price and record.sales_price > 0)})
    return result
