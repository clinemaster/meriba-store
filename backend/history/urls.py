from django.urls import path

from . import views

urlpatterns = [
    path("history/dashboard/", views.DashboardView.as_view(), name="history-dashboard"),
    path("history/imports/", views.ImportView.as_view(), name="history-imports"),
    path("history/imports/dry-run/", views.DryRunView.as_view(), name="history-dry-run"),
    path("history/accept/", views.AcceptView.as_view(), name="history-accept"),
    path("history/exception-report/", views.ExceptionReportView.as_view(), name="history-exception-report"),
    path("history/review-items/", views.ReviewItemListView.as_view(), name="history-items"),
    path("history/review-items/<int:pk>/decide/", views.ReviewItemDecideView.as_view(), name="history-item-decide"),
    path("history/review-items/<int:pk>/notes/", views.ReviewItemNoteView.as_view(), name="history-item-note"),
    path("history/review-items/<int:pk>/reopen/", views.ReviewItemReopenView.as_view(), name="history-item-reopen"),
    path("history/source-products/", views.SourceProductListView.as_view(), name="history-source-products"),
    path("history/source-products/<int:pk>/decide/", views.SourceProductDecideView.as_view(), name="history-source-product-decide"),
    path("history/records/", views.RecordListView.as_view(), name="history-records"),
    path("history/unclassified-rows/", views.UnclassifiedRowListView.as_view(), name="history-rows"),
    path("history/unclassified-rows/decide/", views.UnclassifiedRowDecideView.as_view(), name="history-rows-decide"),
]
