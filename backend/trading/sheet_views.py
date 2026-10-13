import csv
from datetime import date
from decimal import Decimal

from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant, IsSignedIn
from core.errors import BusinessRuleError
from core.services import audit, get_branch
from inventory.services import current_business_date

from . import sheet

# The workbook's headings, in the workbook's order. The opening-stock column has no real heading there.
COLUMNS = [("number", "S/N"), ("details", "Details"), ("opening", "Opening stock"), ("purchases", "Add Purchases"),
           ("total_stock", "Total stock"), ("sales", "Sales"), ("closing_stock", "Closing stock"), ("purchase_price", "Purchase price"),
           ("sales_price", "Sales price"), ("total_sales", "Total Sales"), ("profit", "Profit"), ("stock", "Stock"),
           ("total_purchases", "T.Purchases")]
OFFICE_ONLY = {"purchase_price", "profit", "total_purchases"}


def _plain(value):
    if isinstance(value, Decimal):
        return str(value.normalize()) if value != value.to_integral_value() else str(int(value))
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


class DailySheetView(APIView):
    """The Daily Sheet for one date, in the workbook's layout.

    The cashier types sales on today's sheet (owner's decision, 13 Oct 2026), so the cashier may open it: today only,
    and without the columns that show what the shop pays for its stock or earns on it."""

    permission_classes = [IsSignedIn]

    @extend_schema(responses={200: dict})
    def get(self, request):
        today = current_business_date(get_branch())
        try:
            day = date.fromisoformat(request.query_params["date"]) if request.query_params.get("date") else today
        except ValueError:
            raise BusinessRuleError("Choose a valid date.", code="bad_date", status_code=400)
        office = request.user.is_back_office
        if not office and (day != today or request.query_params.get("download")):
            raise BusinessRuleError("You can open today's sheet only.", code="not_allowed", status_code=403)
        data = sheet.sheet_for(day)
        if not office:
            data["lines"] = [{k: v for k, v in line.items() if k not in OFFICE_ONLY} for line in data["lines"]]
            data["totals"] = {k: v for k, v in data["totals"].items() if k not in OFFICE_ONLY}
            data["previous_date"] = data["next_date"] = None
            return Response({**_plain(data), "columns": [{"key": key, "label": label} for key, label in COLUMNS if key not in OFFICE_ONLY]})

        if request.query_params.get("download") == "csv":
            response = HttpResponse(content_type="text/csv; charset=utf-8")
            response["Content-Disposition"] = f'attachment; filename="meriba_daily_sheet_{day}.csv"'
            response.write("﻿")
            writer = csv.writer(response)
            writer.writerow(["MERIBA STORE", str(day), data["note"]])
            writer.writerow([label for _, label in COLUMNS])
            for line in data["lines"]:
                writer.writerow(["" if line[key] is None else _plain(line[key]) for key, _ in COLUMNS])
            writer.writerow(["", "TOTAL", "", _plain(data["totals"]["purchases"]), "", _plain(data["totals"]["sales"]), "", "", "",
                             _plain(data["totals"]["total_sales"]), _plain(data["totals"]["profit"]), _plain(data["totals"]["stock"]),
                             _plain(data["totals"]["total_purchases"])])
            audit(request.user, "report.exported", summary=f"Exported the Daily Sheet for {day}")
            return response

        return Response({**_plain(data), "columns": [{"key": key, "label": label} for key, label in COLUMNS]})


class WorkbookComparisonView(APIView):
    """Runs the workbook's formulas over every imported line and reports where the workbook shows something else."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        result = sheet.compare_with_workbook()
        return Response({**result, "mismatches": result["mismatches"][:200], "blank_cells": result["blank_cells"][:200],
                         "opening_not_previous_closing": result["opening_not_previous_closing"][:200],
                         "counts": {"mismatches": len(result["mismatches"]), "blank_cells": len(result["blank_cells"]),
                                    "opening_not_previous_closing": len(result["opening_not_previous_closing"])}})
