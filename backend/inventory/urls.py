from django.urls import path

from . import views

urlpatterns = [
    path("stock/movements/", views.MovementListView.as_view(), name="stock-movements"),
    path("stock/opening/", views.OpeningStockView.as_view(), name="stock-opening"),
    path("stock/opening/confirm/", views.OpeningStockConfirmView.as_view(), name="stock-opening-confirm"),
    path("stock/adjustments/", views.StockAdjustmentView.as_view(), name="stock-adjustments"),
]
