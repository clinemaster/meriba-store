from django.urls import path

from . import views

urlpatterns = [
    path("settings/", views.SettingsView.as_view(), name="settings"),
    path("setup/status/", views.SetupStatusView.as_view(), name="setup-status"),
    path("setup/opening-balance/", views.PrepareOpeningBalanceView.as_view(), name="setup-opening-balance"),
    path("setup/go-live/", views.GoLiveView.as_view(), name="setup-go-live"),
    path("audit-log/", views.AuditLogListView.as_view(), name="audit-log"),
]
