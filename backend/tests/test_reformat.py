"""Unit tests for reformat helpers. Full MPR end-to-end testing needs a
real CT volume — left as a future exercise. These tests cover the
stand-alone math used to pick slab centres and voxel ranges."""

from __future__ import annotations

import numpy as np
import pytest

from app.reformat import MODES, ORIENTATIONS, project_slab, slab_indices, slab_range


def test_orientations_and_modes_exposed():
    assert ORIENTATIONS == ('axial', 'coronal', 'sagittal')
    assert set(MODES) == {'mip', 'minip', 'avg'}


def test_slab_indices_evenly_spaced():
    centres = slab_indices(0.0, 30.0, thickness=3.0, spacing=3.0)
    assert centres[0] == pytest.approx(1.5)
    assert centres[-1] <= 30.0
    diffs = np.diff(centres)
    assert np.allclose(diffs, 3.0)


def test_slab_indices_empty_when_thickness_exceeds_extent():
    assert slab_indices(0.0, 5.0, thickness=10.0, spacing=1.0) == []


def test_slab_range_clamped_to_volume():
    lo, hi = slab_range(center_mm=0.0, thickness=10.0, voxel_spacing=1.0, n_voxels=5)
    assert lo == 0
    assert hi <= 4


def test_slab_range_thin_slab_picks_nearest_voxel():
    lo, hi = slab_range(center_mm=2.5, thickness=0.1, voxel_spacing=1.0, n_voxels=10)
    assert lo == hi  # single-voxel slab


def test_project_mip_takes_max():
    slab = np.array([
        [[1.0, 2.0]],
        [[5.0, 1.0]],
        [[3.0, 4.0]],
    ])  # 3 slices, 1 row, 2 cols
    out = project_slab(slab, 'mip')
    assert np.allclose(out, [[5.0, 4.0]])


def test_project_minip_takes_min():
    slab = np.array([[[1.0, 5.0]], [[3.0, 2.0]]])
    assert np.allclose(project_slab(slab, 'minip'), [[1.0, 2.0]])


def test_project_avg_takes_mean():
    slab = np.array([[[2.0, 4.0]], [[4.0, 8.0]]])
    assert np.allclose(project_slab(slab, 'avg'), [[3.0, 6.0]])


def test_project_single_slice_passthrough():
    slab = np.array([[[7.0, 8.0]]])
    assert np.allclose(project_slab(slab, 'mip'), [[7.0, 8.0]])
    assert np.allclose(project_slab(slab, 'avg'), [[7.0, 8.0]])
