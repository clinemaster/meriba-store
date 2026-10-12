import logging

from django.contrib.auth import authenticate, login, logout, password_validation, update_session_auth_hash
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from core.errors import BusinessRuleError
from core.services import audit

from .models import User
from .permissions import IsOwner, IsSignedIn

logger = logging.getLogger("meriba.auth")


class UserSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = ["id", "username", "full_name", "display_name", "role", "is_active", "must_change_password", "last_login"]
        read_only_fields = ["id", "must_change_password", "last_login"]


def _validated_password(password: str, user=None) -> str:
    try:
        password_validation.validate_password(password, user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError({"password": list(exc.messages)})
    return password


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    """The website calls this once so the browser receives the anti-forgery cookie."""

    permission_classes = [AllowAny]
    authentication_classes = []

    @extend_schema(responses={200: dict})
    def get(self, request):
        return Response({"csrfToken": get_token(request)})


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(max_length=128, trim_whitespace=False)


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    @extend_schema(request=LoginSerializer, responses=UserSerializer)
    def post(self, request):
        ser = LoginSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        username = ser.validated_data["username"].strip()
        user = authenticate(request, username=username, password=ser.validated_data["password"])
        if user is None or not user.is_active:
            # Same message for every failure so the screen does not reveal which usernames exist.
            logger.warning("Failed sign-in for username=%s", username[:150])
            audit(None, "auth.login_failed", summary=f"Failed sign-in for '{username[:100]}'")
            raise BusinessRuleError(
                "The username or password is not correct. Please try again.", code="bad_credentials", status_code=400
            )
        login(request, user)
        audit(user, "auth.login", user, summary="Signed in")
        return Response(UserSerializer(user).data)


class LogoutView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(request=None, responses={204: None})
    def post(self, request):
        audit(request.user, "auth.logout", request.user, summary="Signed out")
        logout(request)
        return Response(status=204)


class MeView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(responses=UserSerializer)
    def get(self, request):
        return Response(UserSerializer(request.user).data)


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(trim_whitespace=False)
    new_password = serializers.CharField(trim_whitespace=False)


class ChangePasswordView(APIView):
    permission_classes = [IsSignedIn]

    @extend_schema(request=ChangePasswordSerializer, responses=UserSerializer)
    def post(self, request):
        ser = ChangePasswordSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = request.user
        if not user.check_password(ser.validated_data["current_password"]):
            raise serializers.ValidationError({"current_password": ["Your current password is not correct."]})
        user.set_password(_validated_password(ser.validated_data["new_password"], user))
        user.must_change_password = False
        user.save(update_fields=["password", "must_change_password"])
        update_session_auth_hash(request, user)
        audit(user, "auth.password_changed", user, summary="Changed own password")
        return Response(UserSerializer(user).data)


class UserCreateSerializer(UserSerializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["password"]


class ResetPasswordSerializer(serializers.Serializer):
    password = serializers.CharField(trim_whitespace=False)


class UserViewSet(viewsets.ModelViewSet):
    """Owner-only user management. Accounts are deactivated, never deleted."""

    permission_classes = [IsOwner]
    queryset = User.objects.all()
    http_method_names = ["get", "post", "patch"]

    def get_serializer_class(self):
        return UserCreateSerializer if self.action == "create" else UserSerializer

    @transaction.atomic
    def perform_create(self, serializer):
        password = serializer.validated_data.pop("password")
        user = User(**serializer.validated_data, must_change_password=True)
        user.set_password(_validated_password(password, user))
        user.save()
        serializer.instance = user
        audit(self.request.user, "user.created", user, summary=f"Created {user.role} account '{user.username}'")

    @transaction.atomic
    def perform_update(self, serializer):
        user = User.objects.select_for_update().get(pk=serializer.instance.pk)
        before = {"role": user.role, "is_active": user.is_active, "full_name": user.full_name, "username": user.username}
        new_role = serializer.validated_data.get("role", user.role)
        new_active = serializer.validated_data.get("is_active", user.is_active)
        losing_owner = user.is_owner and (new_role != User.Role.OWNER or not new_active)
        if losing_owner:
            if user.pk == self.request.user.pk:
                raise BusinessRuleError("You cannot remove your own Owner access.", code="self_lockout")
            others = User.objects.select_for_update().filter(role=User.Role.OWNER, is_active=True).exclude(pk=user.pk)
            if not others.exists():
                raise BusinessRuleError("There must always be at least one active Owner.", code="last_owner")
        user = serializer.save()
        after = {"role": user.role, "is_active": user.is_active, "full_name": user.full_name, "username": user.username}
        if before != after:
            audit(self.request.user, "user.changed", user, summary=f"Changed account '{user.username}'", before=before, after=after)

    @extend_schema(request=ResetPasswordSerializer, responses=UserSerializer)
    @action(detail=True, methods=["post"], url_path="reset-password")
    def reset_password(self, request, pk=None):
        user = self.get_object()
        ser = ResetPasswordSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user.set_password(_validated_password(ser.validated_data["password"], user))
        user.must_change_password = True
        user.save(update_fields=["password", "must_change_password"])
        audit(request.user, "user.password_reset", user, summary=f"Reset password for '{user.username}'")
        return Response(UserSerializer(user).data)
