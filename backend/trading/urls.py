from django.urls import path

from . import views

urlpatterns = [
    path("day/current/", views.CurrentDayView.as_view(), name="day-current"),
    path("day/start/", views.StartDayView.as_view(), name="day-start"),
    path("days/", views.DayListView.as_view(), name="day-list"),
    path("days/<int:pk>/corrections/", views.DayCorrectionView.as_view(), name="day-correction"),
    path("shifts/", views.ShiftListView.as_view(), name="shift-list"),
    path("shifts/<int:pk>/", views.ShiftDetailView.as_view(), name="shift-detail"),
    path("shifts/<int:pk>/close/", views.CloseShiftView.as_view(), name="shift-close"),
    path("shifts/<int:pk>/review/", views.ReviewShiftView.as_view(), name="shift-review"),
]
