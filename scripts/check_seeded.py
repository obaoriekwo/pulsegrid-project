"""Exits 0 if the database already has equipment rows (already seeded),
1 if it's empty (needs seeding). Used by start.bat."""
import sys

try:
    from app.database import SessionLocal
    from app.models import Equipment
    db = SessionLocal()
    count = db.query(Equipment).count()
    db.close()
    sys.exit(0 if count > 0 else 1)
except Exception as e:
    print(f"Seeded-check failed: {e}", file=sys.stderr)
    sys.exit(1)
