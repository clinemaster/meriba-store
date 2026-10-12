"""Plain-language API errors. Responses never include stack traces or internal details."""
import logging

from django.core.exceptions import PermissionDenied
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler

logger = logging.getLogger("meriba.errors")


class BusinessRuleError(Exception):
    """A request that is well-formed but not allowed by a business rule."""

    def __init__(self, message: str, code: str = "not_allowed", status_code: int = status.HTTP_409_CONFLICT, details=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details


def _first_message(detail) -> str:
    if isinstance(detail, dict):
        for value in detail.values():
            return _first_message(value)
    if isinstance(detail, (list, tuple)) and detail:
        return _first_message(detail[0])
    return str(detail)


def api_exception_handler(exc, context):
    if isinstance(exc, BusinessRuleError):
        body = {"message": exc.message, "code": exc.code}
        if exc.details is not None:
            body["details"] = exc.details
        return Response(body, status=exc.status_code)

    response = exception_handler(exc, context)
    if response is None:
        logger.exception("Unhandled error in %s", context.get("view").__class__.__name__)
        return Response(
            {"message": "Something went wrong on our side. Nothing was saved. Please try again.", "code": "server_error"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    if isinstance(exc, exceptions.ValidationError):
        body = {"message": _first_message(exc.detail), "code": "invalid", "errors": exc.detail}
    elif isinstance(exc, (exceptions.NotAuthenticated, exceptions.AuthenticationFailed)):
        body = {"message": "Please sign in to continue.", "code": "not_signed_in"}
        response.status_code = status.HTTP_401_UNAUTHORIZED
    elif isinstance(exc, (exceptions.PermissionDenied, PermissionDenied)):
        body = {"message": "You do not have permission to do this.", "code": "forbidden"}
    elif isinstance(exc, (exceptions.NotFound, Http404)):
        body = {"message": "We could not find what you were looking for.", "code": "not_found"}
    elif isinstance(exc, exceptions.Throttled):
        body = {"message": "Too many attempts. Please wait a minute and try again.", "code": "too_many_attempts"}
    else:
        body = {"message": _first_message(getattr(exc, "detail", "This request could not be completed.")), "code": "error"}
    response.data = body
    return response
