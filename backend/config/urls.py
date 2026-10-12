from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

from core.views import health

api_v1 = [
    path("health/", health, name="health"),
    path("auth/", include("accounts.urls_auth")),
    path("users/", include("accounts.urls_users")),
    path("", include("core.urls")),
    path("", include("catalog.urls")),
    path("", include("inventory.urls")),
    path("", include("trading.urls")),
    path("", include("sales.urls")),
    path("", include("finance.urls")),
    path("", include("reports.urls")),
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
]

urlpatterns = [path("api/v1/", include(api_v1))]
