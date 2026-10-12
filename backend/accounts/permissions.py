"""Role checks enforced on the server for every endpoint (hiding menus is never enough)."""
from rest_framework.permissions import BasePermission


class DenyAll(BasePermission):
    """Project default: an endpoint with no explicit permission is closed to everyone."""

    def has_permission(self, request, view):
        return False


def _active(request) -> bool:
    user = request.user
    return bool(user and user.is_authenticated and user.is_active)


class IsSignedIn(BasePermission):
    def has_permission(self, request, view):
        return _active(request)


class IsOwner(BasePermission):
    def has_permission(self, request, view):
        return _active(request) and request.user.is_owner


class IsOwnerOrAccountant(BasePermission):
    def has_permission(self, request, view):
        return _active(request) and request.user.is_back_office
