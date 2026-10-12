from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("suppliers", views.SupplierViewSet, basename="supplier")

urlpatterns = router.urls + [
    path("stock/receipts/", views.GoodsReceiptView.as_view(), name="stock-receipts"),
    path("expenses/", views.ExpenseView.as_view(), name="expense-list"),
    path("expenses/categories/", views.ExpenseCategoriesView.as_view(), name="expense-categories"),
    path("expenses/<int:pk>/void/", views.ExpenseVoidView.as_view(), name="expense-void"),
]
