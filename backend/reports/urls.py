from django.urls import path

from . import views

urlpatterns = [
    path("reports/", views.ReportListView.as_view(), name="report-list"),
    path("reports/<slug:name>/", views.ReportView.as_view(), name="report"),
]
