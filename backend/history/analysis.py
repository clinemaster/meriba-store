"""Finds exceptions in historical daily records. Pure functions: nothing here reads or writes the database.

It only reports what the source shows. It never fills a gap, estimates a quantity, picks a price or
decides what a difference means; those are a reviewer's decisions.
"""
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

ZERO = Decimal("0")
QTY_FIELDS = ("opening_qty", "purchases_qty", "sold_qty", "closing_qty")
PRICE_TYPES = (("sales_price", "SELLING", "Sales price"), ("purchase_price", "PURCHASE_COST", "Purchase price"))


def plain(value):
    """Make a value safe to store as JSON without losing precision."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, Decimal):
        return str(value.normalize()) if value != value.to_integral_value() else str(int(value))
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [plain(v) for v in value]
    return str(value)


def validate_record(row: dict) -> tuple[str, list[str]]:
    """Checks one line against itself. Empty quantity cells count as nothing moved, which is how the sheets are kept."""
    if row.get("errors"):
        return "ERROR", list(row["errors"])
    messages = []
    opening, bought, sold, closing = (row.get(f) or ZERO for f in QTY_FIELDS)
    if row.get("closing_qty") is None and row.get("opening_qty") is None:
        messages.append("Opening and closing stock are both empty.")
    elif opening + bought - sold != closing:
        messages.append(f"Opening {plain(opening)} + purchases {plain(bought)} − sales {plain(sold)} is "
                        f"{plain(opening + bought - sold)}, but closing stock says {plain(closing)}.")
    if any((row.get(f) or ZERO) < 0 for f in QTY_FIELDS):
        messages.append("A quantity is negative.")
    if any((row.get(f) or ZERO) != (row.get(f) or ZERO).to_integral_value() for f in QTY_FIELDS):
        messages.append("A quantity is not a whole number.")
    price, total = row.get("sales_price"), row.get("total_sales")
    if total is not None and price is not None and abs(sold * price - total) > Decimal("0.5"):
        messages.append(f"Sales {plain(sold)} × sales price {plain(price)} is {plain(sold * price)}, but total sales says {plain(total)}.")
    return ("WARNING" if messages else "VALID"), messages


def _ref(row) -> dict:
    return {"worksheet": row["worksheet"], "row": row["row"], "date": str(row["date"])}


def price_history(rows: list[dict], field: str) -> list[dict]:
    """Runs of the same recorded amount, in date order. Empty cells are skipped, not treated as zero."""
    runs = []
    for row in sorted(rows, key=lambda r: r["date"]):
        amount = row.get(field)
        if amount is None:
            continue
        if runs and runs[-1]["amount"] == plain(amount):
            runs[-1]["to"] = str(row["date"])
        else:
            runs.append({"amount": plain(amount), "from": str(row["date"]), "to": str(row["date"])})
    return runs


def _is_anomaly(old: Decimal, new: Decimal, field: str, row: dict) -> str | None:
    if old > 0 and new < old * Decimal("0.5"):
        return "fell by more than half"
    if old > 0 and new > old * 2:
        return "more than doubled"
    price, cost = row.get("sales_price"), row.get("purchase_price")
    if field == "purchase_price" and price and cost is not None:
        if cost > price:
            return "is now higher than the sales price"
        if cost > 0 and cost < price * Decimal("0.2"):
            return "is now less than a fifth of the sales price"
    return None


def analyse(records: list[dict]) -> list[dict]:
    """Returns exception descriptions: {key, kind, severity, title, details, date_from, date_to, sp_keys, record_keys}."""
    issues = []
    by_date = defaultdict(list)
    for row in records:
        by_date[row["date"]].append(row)
    dates = sorted(by_date)

    # 1. Missing dates, and stock that does not carry forward from one sheet to the next.
    for previous, current in zip(dates, dates[1:]):
        before = {r["serial"]: r for r in by_date[previous]}
        breaks = []
        for row in by_date[current]:
            earlier = before.get(row["serial"])
            if earlier is None or earlier.get("closing_qty") is None or row.get("opening_qty") is None:
                continue
            if earlier["closing_qty"] != row["opening_qty"]:
                breaks.append((earlier, row))
        gap_days = (current - previous).days - 1
        affected = [{"serial": new["serial"], "product": new["name"], "closing_before": plain(old["closing_qty"]),
                     "opening_after": plain(new["opening_qty"]), "difference": plain(new["opening_qty"] - old["closing_qty"]),
                     "before": _ref(old), "after": _ref(new)} for old, new in breaks]
        if gap_days > 0:
            first, last = previous + timedelta(days=1), current - timedelta(days=1)
            issues.append({
                "key": f"MISSING_DATES|{first}|{last}", "kind": "MISSING_DATES",
                "severity": "MATERIAL" if breaks else "INFO",
                "title": (f"No sheet for {first:%d %b %Y}" if gap_days == 1 else f"No sheets for {first:%d %b} to {last:%d %b %Y} ({gap_days} days)")
                         + (f"; stock of {len(breaks)} product(s) changed with no record" if breaks else "; no stock changed across the gap"),
                "details": {"missing_dates": [str(first + timedelta(days=i)) for i in range(gap_days)],
                            "last_sheet_before": str(previous), "first_sheet_after": str(current), "affected_products": affected,
                            "statement": "Nothing has been filled in for these dates. The differences are shown as recorded and "
                                         "are not assumed to be sales, purchases or any other movement."},
                "date_from": first, "date_to": last,
                "sp_keys": sorted({new["sp_key"] for _, new in breaks}), "record_keys": [new["key"] for _, new in breaks],
            })
        elif breaks:
            issues.append({
                "key": f"CARRY_FORWARD|{current}", "kind": "CARRY_FORWARD_BREAK", "severity": "MATERIAL",
                "title": f"Opening stock on {current:%d %b %Y} differs from the previous day's closing stock for {len(breaks)} product(s)",
                "details": {"previous_sheet": str(previous), "affected_products": affected},
                "date_from": current, "date_to": current,
                "sp_keys": sorted({new["sp_key"] for _, new in breaks}), "record_keys": [new["key"] for _, new in breaks],
            })

    # 2. The same name on more than one line of a sheet (e.g. two "Henken" lines).
    by_name = defaultdict(lambda: defaultdict(list))
    for row in records:
        by_name[row["norm"]][row["serial"]].append(row)
    for norm, lines in by_name.items():
        together = [d for d in dates if sum(1 for rows in lines.values() if any(r["date"] == d for r in rows)) > 1]
        if len(lines) < 2 or not together:
            continue
        entries = [{"serial": serial, "name": rows[-1]["name"], "source_key": rows[-1]["sp_key"],
                    "sales_price_history": price_history(rows, "sales_price"),
                    "purchase_price_history": price_history(rows, "purchase_price"),
                    "first": _ref(min(rows, key=lambda r: r["date"])), "last": _ref(max(rows, key=lambda r: r["date"])),
                    "sheets": len(rows)} for serial, rows in sorted(lines.items())]
        differ = len({tuple(h["amount"] for h in e["sales_price_history"]) for e in entries}) > 1
        issues.append({
            "key": f"SAME_NAME|{norm}", "kind": "SAME_NAME_DIFFERENT_PRICE", "severity": "MATERIAL",
            "title": f"“{entries[0]['name']}” appears on {len(entries)} lines of the same sheet"
                     + (" with different prices" if differ else ""),
            "details": {"lines": entries, "appear_together_on": len(together),
                        "statement": "Both lines are kept exactly as recorded. They have not been merged and no price has been preferred."},
            "date_from": together[0], "date_to": together[-1],
            "sp_keys": sorted({r["sp_key"] for rows in lines.values() for r in rows}),
            "record_keys": [r["key"] for rows in lines.values() for r in rows],
        })

    # 3. Price changes that look unusual, per price type. 4. Lines with no selling price.
    by_serial = defaultdict(list)
    for row in records:
        by_serial[row["serial"]].append(row)
    for serial, rows in by_serial.items():
        rows.sort(key=lambda r: r["date"])
        for field, price_type, label in PRICE_TYPES:
            previous = None
            for index, row in enumerate(rows):
                amount = row.get(field)
                if amount is None:
                    continue
                if previous is not None and previous.get(field) != amount:
                    why = _is_anomaly(previous[field], amount, field, row)
                    if why:
                        same_after = [r for r in rows[index:] if r.get(field) == amount]
                        issues.append({
                            "key": f"PRICE_ANOMALY|{serial}|{price_type}|{row['date']}", "kind": "PRICE_ANOMALY", "severity": "MATERIAL",
                            "title": f"{row['name']}: {label.lower()} changed from {plain(previous[field])} to {plain(amount)} "
                                     f"on {row['date']:%d %b %Y} ({why})",
                            "details": {"price_type_as_labelled": price_type, "workbook_column": label, "reason_flagged": why,
                                        "old_value": plain(previous[field]), "old_source": _ref(previous),
                                        "new_value": plain(amount), "new_source": _ref(row),
                                        "other_prices_on_that_day": {"sales_price": plain(row.get("sales_price")),
                                                                     "purchase_price": plain(row.get("purchase_price"))},
                                        "sheets_with_new_value": len(same_after),
                                        "statement": "Both values are kept exactly as recorded. Neither has been changed."},
                            "date_from": row["date"], "date_to": same_after[-1]["date"],
                            "sp_keys": sorted({r["sp_key"] for r in same_after}), "record_keys": [r["key"] for r in same_after],
                        })
                previous = row
        latest = rows[-1]
        if not latest.get("sales_price"):
            ever = [r for r in rows if r.get("sales_price")]
            issues.append({
                "key": f"MISSING_PRICE|{latest['sp_key']}", "kind": "MISSING_PRICE", "severity": "MATERIAL",
                "title": f"{latest['name']} has no sales price" + ("" if ever else " on any sheet"),
                "details": {"latest": _ref(latest), "sales_price_recorded": plain(latest.get("sales_price")),
                            "purchase_price_recorded": plain(latest.get("purchase_price")),
                            "closing_stock_recorded": plain(latest.get("closing_qty")), "sheets": len(rows),
                            "statement": "No price has been invented. The product cannot be put on sale until the Owner approves a selling price."},
                "date_from": rows[0]["date"], "date_to": latest["date"],
                "sp_keys": sorted({r["sp_key"] for r in rows}), "record_keys": [r["key"] for r in rows if not r.get("sales_price")],
            })

    # 5. Lines whose own figures do not add up, or could not be read.
    for day in dates:
        for status, kind, key, text in (("WARNING", "ARITHMETIC", "ARITHMETIC", "do not add up"),
                                       ("ERROR", "INVALID_VALUES", "INVALID_VALUES", "could not be read as numbers")):
            bad = [r for r in by_date[day] if r["validation_status"] == status]
            if bad:
                issues.append({
                    "key": f"{key}|{day}", "kind": kind, "severity": "MATERIAL",
                    "title": f"{len(bad)} line(s) on {day:%d %b %Y} {text}",
                    "details": {"lines": [{"product": r["name"], **_ref(r), "problems": r["validation_messages"]} for r in bad]},
                    "date_from": day, "date_to": day,
                    "sp_keys": sorted({r["sp_key"] for r in bad}), "record_keys": [r["key"] for r in bad],
                })
    return issues


def source_product_flags(rows_for_key: list[dict], names_for_serial: set[str], pack_text: str) -> list[str]:
    flags = []
    if len(names_for_serial) > 1:
        flags.append("NAME_VARIANT")  # the same line number carries different names on different dates
    if not pack_text:
        flags.append("UNIT_NOT_STATED")
    elif "box" in pack_text.lower():
        flags.append("PACK_SIZE_AMBIGUOUS")  # "Box (24)": is one unit a bottle or a box?
    if len(price_history(rows_for_key, "sales_price")) > 1:
        flags.append("SELLING_PRICE_CHANGED")
    if len(price_history(rows_for_key, "purchase_price")) > 1:
        flags.append("PURCHASE_PRICE_CHANGED")
    if not rows_for_key or not max(rows_for_key, key=lambda r: r["date"]).get("sales_price"):
        flags.append("MISSING_PRICE")
    return flags


def propose_unit(pack_text: str) -> str:
    """Only proposes when the sheet states the unit plainly. Otherwise the Owner must say."""
    text = pack_text.lower().strip()
    if text.startswith("bottle"):
        return "Bottle"
    if text.startswith(("cret", "crate")):
        return "Crate"
    if text.startswith("carton"):
        return "Carton"
    return ""
