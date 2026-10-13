import csv
from datetime import date
from decimal import Decimal

from django.http import HttpResponse
from drf_spectacular.utils import extend_schema
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import IsOwnerOrAccountant
from core.errors import BusinessRuleError
from core.services import audit, get_branch
from inventory.services import current_business_date

from . import sheet

# The workbook's headings, in the workbook's order. The opening-stock column has no real heading there.
COLUMNS = [("number", "S/N"), ("details", "Details"), ("opening", "Opening stock"), ("purchases", "Add Purchases"),
           ("total_stock", "Total stock"), ("sales", "Sales"), ("closing_stock", "Closing stock"), ("purchase_price", "Purchase price"),
           ("sales_price", "Sales price"), ("total_sales", "Total Sales"), ("profit", "Profit"), ("stock", "Stock"),
           ("total_purchases", "T.Purchases")]


def _plain(value):
    if isinstance(value, Decimal):
        return str(value.normalize()) if value != value.to_integral_value() else str(int(value))
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


class DailySheetView(APIView):
    """The Daily Sheet for one date, in the workbook's layout. It shows purchase prices and profit: back office only."""

    permission_classes = [IsOwnerOrAccountant]

    @extend_schema(responses={200: dict})
    def get(self, request):
        try:
            day = date.fromisoformat(request.query_params["date"]) if request.query_params.get("date") else current_business_date(get_branch())
        except ValueError:
            raise BusinessRuleError("Choose a valid date.", code="bad_date", status_code=400)
        data = sheet.sheet_for(day)

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
