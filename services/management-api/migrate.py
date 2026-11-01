"""Apply PostgreSQL migrations for the UCAS Management API.

Usage:
  UCAS_DATABASE_URL=postgresql://... python services/management-api/migrate.py
"""
import os
import sys

from persistence import apply_migrations

if __name__ == "__main__":
    if not os.environ.get("UCAS_DATABASE_URL"):
        print("UCAS_DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    apply_migrations()
    print("UCAS PostgreSQL migrations applied")
