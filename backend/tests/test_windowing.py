"""Tests for apply_window. Invariants: WindowCenter / WindowWidth are set
to the given values, pixel data is untouched, stale explanations don't
survive."""

from __future__ import annotations

from app.windowing import PRESETS, apply_window


def test_window_center_and_width_set(minimal_ds):
    apply_window(minimal_ds, 40, 80)
    assert float(minimal_ds.WindowCenter) == 40.0
    assert float(minimal_ds.WindowWidth) == 80.0


def test_window_pixel_data_untouched(minimal_ds):
    before = bytes(minimal_ds.PixelData)
    apply_window(minimal_ds, -600, 1500)
    assert bytes(minimal_ds.PixelData) == before


def test_window_explanation_cleared(minimal_ds):
    minimal_ds.WindowCenterWidthExplanation = 'SOFT TISSUE'
    apply_window(minimal_ds, 40, 400)
    assert 'WindowCenterWidthExplanation' not in minimal_ds


def test_window_overwrites_existing(minimal_ds):
    minimal_ds.WindowCenter = 100
    minimal_ds.WindowWidth = 200
    apply_window(minimal_ds, 40, 80)
    assert float(minimal_ds.WindowCenter) == 40.0
    assert float(minimal_ds.WindowWidth) == 80.0


def test_presets_well_formed():
    assert 'brain' in PRESETS
    assert 'lung' in PRESETS
    for name, (center, width) in PRESETS.items():
        assert isinstance(center, (int, float))
        assert isinstance(width, (int, float))
        assert width > 0, f'{name} has non-positive width {width}'
