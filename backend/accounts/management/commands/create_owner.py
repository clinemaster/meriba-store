import getpass

from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from accounts.models import User
from core.services import audit


class Command(BaseCommand):
    help = "Create the first Owner account. The password is typed at the prompt, never on the command line."

    def add_arguments(self, parser):
        parser.add_argument("username")
        parser.add_argument("--full-name", default="")

    def handle(self, *args, **options):
        username = options["username"].strip()
        if User.objects.filter(username__iexact=username).exists():
            raise CommandError(f"A user called '{username}' already exists.")
        password = getpass.getpass("Password: ")
        if password != getpass.getpass("Password (again): "):
            raise CommandError("The two passwords did not match.")
        user = User(username=username, full_name=options["full_name"], role=User.Role.OWNER)
        try:
            password_validation.validate_password(password, user)
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages))
        user.set_password(password)
        user.save()
        audit(None, "user.created", user, summary=f"Owner account '{username}' created from the command line")
        self.stdout.write(self.style.SUCCESS(f"Owner account '{username}' created."))
