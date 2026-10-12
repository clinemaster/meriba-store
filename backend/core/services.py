"""Shared helpers: money rounding, branch lookup, business date, audit logging."""
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

from .errors import BusinessRuleError
from .middleware import current_context
from .models import AuditLog, Branch, BusinessSettings

CENT = Decimal("0.01")


def money(value) -> Decimal:
    """Rounding policy: every monetary amount is rounded half-up to 2 decimal places."""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def get_branch() -> Branch:
    branch = Branch.objects.filter(is_active=True).order_by("id").first()
    if branch is None:
        raise BusinessRuleError("No shop branch has been set up yet.", code="no_branch")
    return branch


def get_settings(branch: Branch | None = None) -> BusinessSettings:
    branch = branch or get_branch()
    obj, _ = BusinessSettings.objects.get_or_create(branch=branch)
    return obj


def local_today() -> date:
    return timezone.now().astimezone(ZoneInfo(settings.BUSINESS_TIMEZONE)).date()


def _jsonable(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (bool, int, str)):
        return value
    return str(value)


def audit(actor, action: str, entity=None, *, summary="", reason="", before=None, after=None) -> AuditLog:
    ctx = current_context()
    return AuditLog.objects.create(
        actor=actor if getattr(actor, "pk", None) else None,
        actor_username=getattr(actor, "username", "") or "",
        action=action,
        entity_type=entity.__class__.__name__ if entity is not None else "",
        entity_id=str(getattr(entity, "pk", "") or ""),
        summary=summary[:255],
        reason=(reason or "")[:500],
        before=_jsonable(before),
        after=_jsonable(after),
        ip_address=ctx.get("ip"),
        request_id=ctx.get("request_id", ""),
    )
