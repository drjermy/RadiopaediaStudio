"""Invariant tests for scrub(). These target properties that must hold
regardless of which tags are on the allowlist, so adding a tag to
KEEP_TAGS shouldn't require updating these tests.
"""

from __future__ import annotations

import pytest
from pydicom.datadict import keyword_for_tag

from app.anonymizer import KEEP_TAGS, scrub


# -- De-identification flags ------------------------------------------------


def test_patient_identity_removed_set(minimal_ds):
    scrub(minimal_ds)
    assert minimal_ds.PatientIdentityRemoved == 'YES'


def test_deidentification_method_set(minimal_ds):
    scrub(minimal_ds)
    assert minimal_ds.DeidentificationMethod  # non-empty


def test_burned_in_annotation_defaults_no_when_missing(minimal_ds):
    assert 'BurnedInAnnotation' not in minimal_ds
    scrub(minimal_ds)
    assert minimal_ds.BurnedInAnnotation == 'NO'


def test_burned_in_annotation_preserved_when_yes(minimal_ds):
    minimal_ds.BurnedInAnnotation = 'YES'
    scrub(minimal_ds)
    assert minimal_ds.BurnedInAnnotation == 'YES'


# -- UID regeneration -------------------------------------------------------


def test_uids_regenerated_with_225_prefix(minimal_ds):
    scrub(minimal_ds)
    assert minimal_ds.SOPInstanceUID.startswith('2.25.')
    assert minimal_ds.StudyInstanceUID.startswith('2.25.')
    assert minimal_ds.SeriesInstanceUID.startswith('2.25.')


def test_uids_differ_from_original(minimal_ds):
    before = (
        minimal_ds.SOPInstanceUID,
        minimal_ds.StudyInstanceUID,
        minimal_ds.SeriesInstanceUID,
    )
    scrub(minimal_ds)
    after = (
        minimal_ds.SOPInstanceUID,
        minimal_ds.StudyInstanceUID,
        minimal_ds.SeriesInstanceUID,
    )
    assert after != before
    for uid in after:
        assert uid not in before


def test_file_meta_sop_instance_uid_synced(minimal_ds):
    scrub(minimal_ds)
    assert minimal_ds.file_meta.MediaStorageSOPInstanceUID == minimal_ds.SOPInstanceUID


# -- PHI stripping ----------------------------------------------------------


def test_patient_name_dropped(minimal_ds):
    assert 'PatientName' in minimal_ds
    scrub(minimal_ds)
    assert 'PatientName' not in minimal_ds


def test_non_allowlisted_tag_dropped(minimal_ds):
    """PatientBirthDate isn't in KEEP_TAGS — must be stripped."""
    assert 'PatientBirthDate' in minimal_ds
    scrub(minimal_ds)
    assert 'PatientBirthDate' not in minimal_ds


def test_private_tags_dropped(ds_with_private_tags):
    has_private = any(elem.tag.is_private for elem in ds_with_private_tags)
    assert has_private, 'fixture should start with private tags'
    scrub(ds_with_private_tags)
    assert not any(elem.tag.is_private for elem in ds_with_private_tags)


def test_request_attributes_sequence_dropped(ds_with_ras_phi):
    scrub(ds_with_ras_phi)
    assert 'RequestAttributesSequence' not in ds_with_ras_phi


def test_deep_nested_phi_dropped(ds_with_deep_nested_phi):
    """The whole RequestAttributesSequence with 3-level SQ nesting should
    be gone. No need to recurse — current policy is drop-all-SQ."""
    scrub(ds_with_deep_nested_phi)
    assert 'RequestAttributesSequence' not in ds_with_deep_nested_phi


# -- Allowlist preservation -------------------------------------------------


def test_allowlisted_tags_survive(minimal_ds):
    """PatientID, Modality etc. are on KEEP_TAGS and should remain."""
    scrub(minimal_ds)
    for kw in ('PatientID', 'Modality', 'StudyDate', 'SOPClassUID',
               'Rows', 'Columns', 'PixelData'):
        assert kw in minimal_ds, f'{kw} should be preserved'


def test_only_allowlisted_tags_remain(minimal_ds):
    """Post-scrub, every top-level tag must be in KEEP_TAGS. Defense
    against accidentally leaking a tag because the scrub logic changed."""
    scrub(minimal_ds)
    for elem in minimal_ds:
        kw = keyword_for_tag(elem.tag)
        assert kw in KEEP_TAGS, f'unexpected tag survived scrub: {kw or elem.tag}'


# -- scrub()'s return value -------------------------------------------------


def test_scrub_return_shape(minimal_ds):
    kept, dropped, dropped_names = scrub(minimal_ds)
    assert isinstance(kept, int) and kept > 0
    assert isinstance(dropped, int) and dropped >= 0
    assert isinstance(dropped_names, list)
    assert len(dropped_names) == dropped


def test_dropped_list_contains_known_phi(minimal_ds):
    _, _, dropped_names = scrub(minimal_ds)
    assert 'PatientName' in dropped_names
    assert 'PatientBirthDate' in dropped_names


# -- Idempotence ------------------------------------------------------------


def test_scrub_is_idempotent(minimal_ds):
    """Scrubbing a scrubbed dataset should drop nothing new, and all
    invariants still hold. UIDs regenerate each pass — that's expected."""
    scrub(minimal_ds)
    _, dropped_second_pass, _ = scrub(minimal_ds)
    assert dropped_second_pass == 0
    assert minimal_ds.PatientIdentityRemoved == 'YES'
    for elem in minimal_ds:
        kw = keyword_for_tag(elem.tag)
        assert kw in KEEP_TAGS
