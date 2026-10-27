from django.urls import path
from rest_framework.routers import DefaultRouter

from . import import_views, views

router = DefaultRouter()
router.register("suppliers", views.SupplierViewSet, basename="supplier")

urlpatterns = router.urls + [
    path("stock/receipts/", views.GoodsReceiptView.as_view(), name="stock-receipts"),
    path("stock/receipt-imports/", import_views.ReceiptImportView.as_view(), name="receipt-imports"),
    path("stock/receipt-imports/template/", import_views.ReceiptImportTemplateView.as_view(), name="receipt-import-template"),
    path("stock/receipt-imports/<uuid:pk>/", import_views.ReceiptImportPreviewView.as_view(), name="receipt-import"),
    path("stock/receipt-imports/<uuid:pk>/confirm/", import_views.ReceiptImportConfirmView.as_view(), name="receipt-import-confirm"),
    path("expenses/", views.ExpenseView.as_view(), name="expense-list"),
    path("expenses/categories/", views.ExpenseCategoriesView.as_view(), name="expense-categories"),
    path("expenses/<int:pk>/void/", views.ExpenseVoidView.as_view(), name="expense-void"),
]
