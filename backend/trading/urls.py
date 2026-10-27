from django.urls import path

from . import sheet_views, views

urlpatterns = [
    path("daily-sheet/", sheet_views.DailySheetView.as_view(), name="daily-sheet"),
    path("daily-sheet/stock-value/", sheet_views.StockValueView.as_view(), name="daily-sheet-stock-value"),
    path("daily-sheet/compare-with-workbook/", sheet_views.WorkbookComparisonView.as_view(), name="daily-sheet-compare"),
    path("day/current/", views.CurrentDayView.as_view(), name="day-current"),
    path("day/start/", views.StartDayView.as_view(), name="day-start"),
    path("days/", views.DayListView.as_view(), name="day-list"),
    path("days/<int:pk>/corrections/", views.DayCorrectionView.as_view(), name="day-correction"),
    path("days/<int:pk>/opening-balance/", views.DayOpeningBalanceView.as_view(), name="day-opening-balance"),
    path("shifts/", views.ShiftListView.as_view(), name="shift-list"),
    path("shifts/<int:pk>/", views.ShiftDetailView.as_view(), name="shift-detail"),
    path("shifts/<int:pk>/close/", views.CloseShiftView.as_view(), name="shift-close"),
    path("shifts/<int:pk>/float/", views.ShiftFloatView.as_view(), name="shift-float"),
    path("shifts/<int:pk>/review/", views.ReviewShiftView.as_view(), name="shift-review"),
]
