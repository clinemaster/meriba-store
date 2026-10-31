"""Table downloads: CSV and Excel from the same columns and rows, so both always contain the same figures."""
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO

from django.http import HttpResponse

from .csv_utils import _NUMERIC_CELL, SafeCSVWriter

FORMATS = ("csv", "xlsx")


def plain(value):
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return str(value.quantize(Decimal("0.01"))) if value != value.to_integral_value() else str(int(value))
    return str(value)


def _safe_text(value: str) -> str:
    candidate = value.lstrip(" \t\r\n\v\f﻿")
    if candidate.startswith(("=", "+", "-", "@")) and not _NUMERIC_CELL.fullmatch(candidate):
        return "'" + value
    return value


def table_response(fmt: str, filename: str, columns: list[dict], rows: list[dict], totals: dict | None = None, title: str = "") -> HttpResponse:
    """`columns` are {"key", "label", "kind"} as used by the reports; `kind` "money"/"quantity" are written as numbers."""
    totals = totals or {}
    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Font

        wb = Workbook()
        ws = wb.active
        ws.title = (title or "Report")[:31]
        ws.append([c["label"] for c in columns])
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in rows:
            ws.append([_cell(row.get(c["key"]), c.get("kind")) for c in columns])
        if totals:
            ws.append(["TOTAL" if i == 0 else _cell(totals.get(c["key"]), c.get("kind")) for i, c in enumerate(columns)])
            for cell in ws[ws.max_row]:
                cell.font = Font(bold=True)
        for i, c in enumerate(columns, start=1):
            if c.get("kind") == "money":
                for (cell,) in ws.iter_rows(min_row=2, min_col=i, max_col=i):
                    cell.number_format = "#,##0.00"
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = max(12, min(40, len(c["label"]) + 4))
        ws.freeze_panes = "A2"
        buffer = BytesIO()
        wb.save(buffer)
        response = HttpResponse(buffer.getvalue(), content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        response["Content-Disposition"] = f'attachment; filename="{filename}.xlsx"'
        return response

    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}.csv"'
    response.write("﻿")  # so Excel opens it with the right characters
    writer = SafeCSVWriter(response)
    writer.writerow([c["label"] for c in columns])
    for row in rows:
        writer.writerow([plain(row.get(c["key"])) for c in columns])
    if totals:
        writer.writerow(["TOTAL" if i == 0 else plain(totals.get(c["key"])) for i, c in enumerate(columns)])
    return response


def _cell(value, kind):
    """A value for one Excel cell. Text can never become a formula; money stays an exact decimal number."""
    if value is None or value == "":
        return None
    if kind in ("money", "quantity"):
        try:
            return Decimal(str(value))
        except ArithmeticError:
            return _safe_text(str(value))
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, (date, int, Decimal)) and not isinstance(value, bool):
        return value
    return _safe_text(str(value))
