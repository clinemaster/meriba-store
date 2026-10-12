from django.db import migrations, models

APPROVED = ['Crate', 'Carton', 'Box', 'Bottle', 'Pack']
CHOICES = [(unit, unit) for unit in APPROVED]


class Migration(migrations.Migration):
    """From here on the database itself refuses a selling unit that is not on the approved list.

    To approve another unit later (for example "Single"): add it to catalog.models.SoldBy and run
    `manage.py makemigrations catalog`, which produces the migration that widens these rules.
    """

    dependencies = [
        ('catalog', '0002_product_table_costing'),
    ]

    operations = [
        migrations.AlterField(
            model_name='product',
            name='base_unit',
            field=models.CharField(choices=CHOICES, default='Bottle', max_length=30),
        ),
        migrations.AlterField(
            model_name='productunit',
            name='name',
            field=models.CharField(choices=CHOICES, max_length=30),
        ),
        migrations.AddConstraint(
            model_name='product',
            constraint=models.CheckConstraint(condition=models.Q(('base_unit__in', APPROVED)), name='product_sold_by_is_approved_unit'),
        ),
        migrations.AddConstraint(
            model_name='product',
            constraint=models.CheckConstraint(condition=models.Q(('volume_ml__isnull', True), ('volume_ml__gt', 0), _connector='OR'), name='product_volume_positive'),
        ),
        migrations.AddConstraint(
            model_name='product',
            constraint=models.CheckConstraint(condition=models.Q(('bottles_per_unit__isnull', True), ('bottles_per_unit__gt', 0), _connector='OR'), name='product_bottles_per_unit_positive'),
        ),
        migrations.AddConstraint(
            model_name='product',
            constraint=models.CheckConstraint(condition=models.Q(('average_cost__isnull', True), ('average_cost__gte', 0), _connector='OR'), name='product_average_cost_not_negative'),
        ),
        migrations.AddConstraint(
            model_name='productunit',
            constraint=models.CheckConstraint(condition=models.Q(('name__in', APPROVED)), name='product_unit_is_approved_unit'),
        ),
    ]
