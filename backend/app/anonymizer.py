"""Allowlist-based DICOM scrub. Vendored from dicom-dev-kit (scrub_dcm.py).

Keep only tags in KEEP_TAGS, drop everything else including every sequence
and every private tag. Regenerate Study / Series / SOP Instance UIDs. Set
the standard de-identification flags. Default-deny: new PHI tags introduced
by scanner firmware updates can't sneak through just because nobody added
them to a blocklist.
"""

from __future__ import annotations

from pathlib import Path

import pydicom
from pydicom.datadict import keyword_for_tag
from pydicom.uid import generate_uid

KEEP_TAGS = {
    # File meta / identification
    'SpecificCharacterSet', 'ImageType', 'SOPClassUID', 'SOPInstanceUID',
    'Modality', 'Manufacturer', 'ManufacturerModelName',
    'AccessionNumber', 'ReferringPhysicianName',
    'StudyDate', 'SeriesDate', 'AcquisitionDate', 'ContentDate',
    'StudyTime', 'SeriesTime', 'AcquisitionTime', 'ContentTime',
    'SeriesDescription',
    # Patient (coarse demographics only; values pass through from source)
    'PatientID', 'PatientSex', 'PatientAge', 'PatientWeight',
    # De-id flags
    'PatientIdentityRemoved', 'DeidentificationMethod',
    # Acquisition — X-ray / DX / CR
    'ContrastBolusAgent', 'BodyPartExamined',
    'KVP', 'SoftwareVersions',
    'DistanceSourceToDetector', 'DistanceSourceToPatient',
    'ExposureTime', 'XRayTubeCurrent',
    'Exposure', 'ExposureInuAs', 'ImageAndFluoroscopyAreaDoseProduct',
    'ImagerPixelSpacing',
    'DetectorType', 'DetectorDescription',
    'ExposureControlMode', 'ExposureControlModeDescription',
    # Acquisition — CT
    'SliceThickness', 'DataCollectionDiameter', 'ReconstructionDiameter',
    'GantryDetectorTilt', 'TableHeight', 'RotationDirection',
    'FilterType', 'GeneratorPower', 'FocalSpots', 'ConvolutionKernel',
    'SingleCollimationWidth', 'TotalCollimationWidth',
    'TableSpeed', 'TableFeedPerRotation', 'SpiralPitchFactor',
    'ReconstructionTargetCenterPatient', 'ExposureModulationType',
    'CTDIvol',
    # Relationship / geometry
    'StudyInstanceUID', 'SeriesInstanceUID',
    'StudyID', 'SeriesNumber', 'InstanceNumber', 'AcquisitionNumber',
    'PatientOrientation', 'PatientPosition',
    'Laterality', 'ImageLaterality',
    'ImagePositionPatient', 'ImageOrientationPatient',
    'FrameOfReferenceUID', 'PositionReferenceIndicator', 'SliceLocation',
    # Image pixel / presentation (required for valid image display)
    'SamplesPerPixel', 'PhotometricInterpretation', 'PlanarConfiguration',
    'Rows', 'Columns', 'PixelSpacing',
    'BitsAllocated', 'BitsStored', 'HighBit', 'PixelRepresentation',
    'SmallestImagePixelValue', 'LargestImagePixelValue',
    'BurnedInAnnotation',
    'PixelIntensityRelationship', 'PixelIntensityRelationshipSign',
    'WindowCenter', 'WindowWidth',
    'RescaleIntercept', 'RescaleSlope', 'RescaleType',
    'WindowCenterWidthExplanation', 'VOILUTFunction',
    'LossyImageCompression', 'LossyImageCompressionRatio',
    'LossyImageCompressionMethod',
    'PresentationLUTShape',
    # Pixel data itself
    'PixelData',
}


def scrub(ds) -> tuple[int, int, list[str]]:
    ds.remove_private_tags()

    kept = 0
    dropped: list[str] = []
    for elem in list(ds):
        kw = keyword_for_tag(elem.tag)
        if kw and kw in KEEP_TAGS:
            kept += 1
        else:
            dropped.append(kw or f'{elem.tag}')
            del ds[elem.tag]

    ds.SOPInstanceUID = generate_uid(prefix='2.25.')
    ds.StudyInstanceUID = generate_uid(prefix='2.25.')
    ds.SeriesInstanceUID = generate_uid(prefix='2.25.')
    if hasattr(ds, 'file_meta'):
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID

    ds.PatientIdentityRemoved = 'YES'
    ds.DeidentificationMethod = 'pacs-anonymizer allowlist scrub'
    if 'BurnedInAnnotation' not in ds:
        ds.BurnedInAnnotation = 'NO'

    return kept, len(dropped), dropped


def scrub_file(input_path: Path, output_path: Path) -> dict:
    ds = pydicom.dcmread(input_path)
    kept, n_dropped, dropped = scrub(ds)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(output_path, enforce_file_format=True)
    return {'kept': kept, 'dropped': n_dropped, 'dropped_tags': dropped}
