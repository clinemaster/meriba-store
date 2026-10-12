from django.db import migrations


def seed(apps, schema_editor):
    """FR-BR-01: the initial branch is MERIBA Main Branch (name and code stay editable)."""
    Branch = apps.get_model("core", "Branch")
    BusinessSettings = apps.get_model("core", "BusinessSettings")
    if not Branch.objects.exists():
        branch = Branch.objects.create(name="MERIBA Main Branch", code="MB")
        BusinessSettings.objects.create(branch=branch)


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
