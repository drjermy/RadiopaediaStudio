"""Cross-backend classification contract test — Python side.

Reads backend-js/test/classify-fixtures.json and asserts that the Python
classifier returns the expected output for every case.
backend-js/test/classify-contract.test.mjs reads the SAME fixture and
runs the same assertions on the Node side. If one backend drifts, both
tests flag it. See issue #2 and the comment at the top of classify.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.classify import classify_orientation, classify_transfer_syntax


FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / 'backend-js' / 'test' / 'classify-fixtures.json'
)


def _load_fixture() -> dict:
    with open(FIXTURE_PATH, encoding='utf-8') as f:
        return json.load(f)


def test_fixture_exists():
    assert FIXTURE_PATH.is_file(), f'fixture not found: {FIXTURE_PATH}'


@pytest.mark.parametrize('case', _load_fixture()['transfer_syntax'])
def test_transfer_syntax_matches_fixture(case):
    got = classify_transfer_syntax(case['uid'])
    assert got == case['expected'], (
        f'classify_transfer_syntax({case["uid"]!r}) returned {got!r}, '
        f'expected {case["expected"]!r}'
    )


@pytest.mark.parametrize('case', _load_fixture()['orientation'])
def test_orientation_matches_fixture(case):
    got = classify_orientation(case['iop'])
    assert got == case['expected'], (
        f'classify_orientation({case["iop"]!r}) returned {got!r}, '
        f'expected {case["expected"]!r}'
    )
