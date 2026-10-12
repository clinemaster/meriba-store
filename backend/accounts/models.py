from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    class Role(models.TextChoices):
        OWNER = "OWNER", "Owner"
        ACCOUNTANT = "ACCOUNTANT", "Accountant"
        CASHIER = "CASHIER", "Cashier"

    role = models.CharField(max_length=12, choices=Role.choices, default=Role.CASHIER)
    full_name = models.CharField(max_length=150, blank=True)
    # Set when someone else chose the password; the user must pick their own at next sign-in.
    must_change_password = models.BooleanField(default=False)

    class Meta:
        ordering = ["username"]

    @property
    def display_name(self) -> str:
        return self.full_name or self.username

    @property
    def is_owner(self) -> bool:
        return self.role == self.Role.OWNER

    @property
    def is_accountant(self) -> bool:
        return self.role == self.Role.ACCOUNTANT

    @property
    def is_cashier(self) -> bool:
        return self.role == self.Role.CASHIER

    @property
    def is_back_office(self) -> bool:
        return self.role in (self.Role.OWNER, self.Role.ACCOUNTANT)
