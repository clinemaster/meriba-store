import logging
import threading
import uuid

_local = threading.local()


def current_context() -> dict:
    return getattr(_local, "ctx", {})


class RequestContextMiddleware:
    """Gives each request an id and remembers who made it, for logs and audit records."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = uuid.uuid4().hex[:16]
        user = getattr(request, "user", None)
        _local.ctx = {
            "request_id": request_id,
            "ip": request.META.get("REMOTE_ADDR"),
            "user": user.username if user is not None and user.is_authenticated else "-",
        }
        try:
            response = self.get_response(request)
        finally:
            _local.ctx = {}
        response["X-Request-ID"] = request_id
        return response


class RequestContextFilter(logging.Filter):
    def filter(self, record):
        ctx = current_context()
        record.request_id = ctx.get("request_id", "-")
        record.user = ctx.get("user", "-")
        return True
