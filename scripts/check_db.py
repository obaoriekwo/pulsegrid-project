"""Exits 0 if the database is reachable, 1 otherwise. Used by start.bat."""
import sys

try:
    from app.database import engine
    engine.connect()
    sys.exit(0)
except Exception as e:
    print(f"DB connection failed: {e}", file=sys.stderr)
    sys.exit(1)
