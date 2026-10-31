from django.urls import path
from rest_framework.routers import DefaultRouter

from . import payment_views, views

router = DefaultRouter()
router.register("payment-methods", payment_views.PaymentMethodViewSet, basename="payment-method")
router.register("payment-providers", payment_views.PaymentProviderViewSet, basename="payment-provider")

urlpatterns = router.urls + [
    path("sales/", views.SaleListCreateView.as_view(), name="sale-list"),
    path("sales/<int:pk>/", views.SaleDetailView.as_view(), name="sale-detail"),
    path("sales/<int:pk>/void/", views.SaleVoidView.as_view(), name="sale-void"),
    path("sales/<int:pk>/refund/", views.SaleRefundView.as_view(), name="sale-refund"),
    path("refunds/", views.RefundListView.as_view(), name="refund-list"),
    path("payment-summary/", payment_views.PaymentSummaryView.as_view(), name="payment-summary"),
    path("payment-transactions/", payment_views.PaymentTransactionListView.as_view(), name="payment-transactions"),
    path("payments/<int:pk>/provider/", payment_views.PaymentProviderCorrectionView.as_view(), name="payment-provider-correction"),
]
