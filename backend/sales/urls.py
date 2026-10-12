from django.urls import path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("payment-methods", views.PaymentMethodViewSet, basename="payment-method")

urlpatterns = router.urls + [
    path("sales/", views.SaleListCreateView.as_view(), name="sale-list"),
    path("sales/<int:pk>/", views.SaleDetailView.as_view(), name="sale-detail"),
    path("sales/<int:pk>/void/", views.SaleVoidView.as_view(), name="sale-void"),
]
