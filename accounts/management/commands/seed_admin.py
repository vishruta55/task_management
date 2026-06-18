from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Creates default admin user if no users exist in the database'

    def add_arguments(self, parser):
        parser.add_argument(
            '--username',
            default='admin',
            help='Admin username (default: admin)',
        )
        parser.add_argument(
            '--password',
            default='admin123',
            help='Admin password (default: admin123)',
        )
        parser.add_argument(
            '--email',
            default='admin@example.com',
            help='Admin email (default: admin@example.com)',
        )

    def handle(self, *args, **options):
        User = get_user_model()

        if User.objects.exists():
            self.stdout.write(
                self.style.SUCCESS(
                    f'Users already exist ({User.objects.count()} found). Skipping seed.'
                )
            )
            return

        user = User.objects.create_superuser(
            username=options['username'],
            password=options['password'],
            email=options['email'],
        )
        self.stdout.write(
            self.style.SUCCESS(
                f'Created default admin user: {user.username} / {options["password"]}'
            )
        )