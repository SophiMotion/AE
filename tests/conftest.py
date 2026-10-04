"""Prepare empty local runtime folders for tests on a fresh source checkout."""
from pathlib import Path

def pytest_sessionstart(session):
    root = Path(__file__).resolve().parents[1]
    for name in ("runs", ".tools"):
        (root / name).mkdir(exist_ok=True)
