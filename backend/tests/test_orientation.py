"""Orientation classifier — axial/coronal/sagittal from ImageOrientationPatient."""

from app.anonymizer import classify_orientation


# Standard axial orientation: rows R→L, cols A→P (normal ≈ +Z)
def test_axial():
    assert classify_orientation([1, 0, 0, 0, 1, 0]) == 'axial'


def test_axial_flipped_columns():
    # Still axial even when col cosines are negated (slice normal still ±Z)
    assert classify_orientation([1, 0, 0, 0, -1, 0]) == 'axial'


# Coronal: rows R→L, cols S→I (normal ≈ ±Y)
def test_coronal():
    assert classify_orientation([1, 0, 0, 0, 0, -1]) == 'coronal'


# Sagittal: rows A→P, cols S→I (normal ≈ ±X)
def test_sagittal():
    assert classify_orientation([0, 1, 0, 0, 0, -1]) == 'sagittal'


def test_oblique_picks_dominant_axis():
    # Mostly axial but tilted — should still classify as axial
    assert classify_orientation([0.99, 0.1, 0, 0.1, 0.99, 0]) == 'axial'


def test_invalid_returns_none():
    assert classify_orientation(None) is None
    assert classify_orientation([]) is None
    assert classify_orientation([1, 0, 0]) is None
    assert classify_orientation(['x', 0, 0, 0, 1, 0]) is None
