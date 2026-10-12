from django.urls import path

from . import views

urlpatterns = [
    path("stock/movements/", views.MovementListView.as_view(), name="stock-movements"),
    path("stock/opening-counts/", views.OpeningCountView.as_view(), name="opening-counts"),
    path("stock/opening-counts/<int:pk>/", views.OpeningCountDetailView.as_view(), name="opening-count"),
    path("stock/opening-counts/<int:pk>/review/", views.OpeningCountReviewView.as_view(), name="opening-count-review"),
    path("stock/adjustments/", views.StockAdjustmentView.as_view(), name="stock-adjustments"),
]
