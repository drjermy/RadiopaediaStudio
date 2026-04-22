// Cornerstone 3D stack / volume viewer. Bundled by scripts/build-viewer.mjs
// into src/renderer/viewer.bundle.js and exposed as window.viewerAPI.
// Renderer calls viewerAPI.open(folder, container) when a thumbnail is
// clicked.

import * as cornerstone from '@cornerstonejs/core';
import { init as csToolsInit, ToolGroupManager, StackScrollTool,
         WindowLevelTool, PanTool, ZoomTool, Enums as ToolEnums,
         addTool } from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';

const { Enums, RenderingEngine, volumeLoader } = cornerstone;
const { ViewportType, OrientationAxis, BlendModes } = Enums;
const { MouseBindings } = ToolEnums;

const RENDERING_ENGINE_ID = 'pacs-anonymizer-engine';
const VIEWPORT_ID = 'stack-viewport';
const TOOL_GROUP_ID = 'pacs-tools';

let initialized = false;
let renderingEngine = null;
let element = null;
let resizeObserver = null;
let preloadAbort = null;
let currentViewport = null;
let currentIsVolume = false;
let currentOrientation = null;
let keyHandler = null;
let wheelHandler = null;
let voiHandler = null;
let cameraHandler = null;
let trimRange = null; // { start, end } inclusive; null = unrestricted
let clampInFlight = false;
let slabThickness = 1;        // mm, current rendered slab thickness (numerator)
let slabSpacing = 1;          // mm, current scroll step (denominator)
let sourceThickness = null;   // SliceThickness from acquisition, mm
let sourceSpacing = null;     // computed slice spacing along normal, mm
let sourceOrientation = null; // 'axial' | 'coronal' | 'sagittal' — acquisition plane
let currentVolumeId = null;   // unique per-open so we never reuse a cached
                              // volume actor that was bound to a destroyed engine

// Raw voxel spacing along the current slice normal (cornerstone's view of
// the volume grid). Used as the rendering floor — anything less is just
// resampling the same voxel — and as the wheel scroll quantum.
function rawNormalSpacingMm() {
  if (!currentViewport) return 1;
  try { return currentViewport.getSpacingInNormalDirection?.() ?? 1; } catch { return 1; }
}

// Smallest meaningful thickness in the current orientation: cornerstone's
// voxel grid, raised to the source slice thickness when viewing in the
// acquisition plane (so a 3 mm CT can't pretend to be a 1 mm slice).
function thicknessFloor() {
  let f = rawNormalSpacingMm();
  if (sourceThickness != null && currentOrientation === sourceOrientation) {
    f = Math.max(f, sourceThickness);
  }
  return Math.max(1, Math.round(f));
}

// Smallest meaningful spacing — same idea but uses the source slice spacing
// (which is < thickness for overlapping reconstructions).
function spacingFloor() {
  let f = rawNormalSpacingMm();
  if (sourceSpacing != null && currentOrientation === sourceOrientation) {
    f = Math.max(f, sourceSpacing);
  }
  return Math.max(1, Math.round(f));
}

function pickDefaultSlab() {
  // Default to the source acquisition's thickness/spacing in every
  // orientation — a sagittal reformat of a 3/2 mm axial CT should start at
  // 3/2 too. In reformat orientations the per-orientation floor is lower
  // (cornerstone voxel ≈ in-plane mm), so the user can reduce below source
  // with [ and ⇧[ to exploit the in-plane resolution.
  slabThickness = Math.max(thicknessFloor(), sourceThickness ?? thicknessFloor());
  slabSpacing   = Math.max(spacingFloor(),   sourceSpacing   ?? spacingFloor());
}

// Volume dimension index along the current viewport normal. Used to
// translate "slice N at slabSpacing" into volume voxel positions for trim
// and goToSlice.
function orientationNormalDimIdx() {
  if (currentOrientation === OrientationAxis.CORONAL)  return 1;
  if (currentOrientation === OrientationAxis.SAGITTAL) return 0;
  return 2; // axial / default
}

// Number of slider positions at the current slabSpacing — extent of the
// volume along the current view normal divided by the step size.
function currentSliceCount() {
  if (!currentIsVolume || !currentVolumeId) return null;
  const vol = cornerstone.cache.getVolume?.(currentVolumeId);
  if (!vol) return null;
  const dims = vol.dimensions ?? [0, 0, 0];
  const spac = vol.spacing ?? [1, 1, 1];
  const idx = orientationNormalDimIdx();
  const extent = dims[idx] * spac[idx];
  if (!extent || !slabSpacing) return null;
  return Math.max(1, Math.floor(extent / slabSpacing));
}

function isAtNative() {
  // "Native" means we're rendering at the source acquisition values. In the
  // acquisition orientation that coincides with the floor; elsewhere the
  // floor is lower and the user can go under native.
  if (sourceThickness != null && sourceSpacing != null) {
    return Math.abs(slabThickness - sourceThickness) < 0.01
        && Math.abs(slabSpacing   - sourceSpacing)   < 0.01;
  }
  return slabThickness === thicknessFloor() && slabSpacing === spacingFloor();
}

// Remember the first seen VOI so we can tell "untouched" from "user
// dragged W/L back to the same numbers" — used by Save.
let initialVOI = null;

function emitState() {
  if (!currentViewport) return;
  const props = currentViewport.getProperties?.() ?? {};
  const voi = props.voiRange || {};
  const hasVOI = voi.upper != null && voi.lower != null;
  const atNative = currentIsVolume ? isAtNative() : false;

  const center = hasVOI ? (voi.upper + voi.lower) / 2 : null;
  const width  = hasVOI ? voi.upper - voi.lower        : null;
  if (hasVOI && !initialVOI) initialVOI = { center, width };
  const isDefaultVOI = hasVOI && initialVOI
    ? Math.abs(center - initialVOI.center) < 0.5
      && Math.abs(width - initialVOI.width) < 0.5
    : true;

  const isDefaultView = currentIsVolume
    ? currentOrientation === OrientationAxis.AXIAL && atNative
    : true;

  document.dispatchEvent(new CustomEvent('viewer:state', {
    detail: {
      isVolume: currentIsVolume,
      orientation: currentOrientation,
      slabThickness: currentIsVolume ? slabThickness : null,
      slabSpacing:   currentIsVolume ? slabSpacing   : null,
      sliceCount:    currentIsVolume ? currentSliceCount() : null,
      isAtNative: atNative,
      isDefaultView,
      center,
      width,
      isDefaultVOI,
    },
  }));
}

async function ensureInitialized() {
  if (initialized) return;
  await cornerstone.init();
  dicomImageLoader.init({
    maxWebWorkers: Math.min(navigator.hardwareConcurrency || 2, 4),
  });
  await csToolsInit();

  addTool(StackScrollTool);
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);

  const tg = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  tg.addTool(StackScrollTool.toolName);
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);

  tg.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });
  tg.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  tg.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  tg.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });

  initialized = true;
}

async function loadStack(folder) {
  const port = await window.backend.getPort();
  if (!port) throw new Error('python backend not ready');

  const listRes = await fetch(
    `http://127.0.0.1:${port}/files/list?folder=${encodeURIComponent(folder)}`,
  );
  if (!listRes.ok) throw new Error(`list failed: ${listRes.status}`);
  const { files } = await listRes.json();
  if (!files?.length) throw new Error('no files in folder');

  // wadouri scheme is what the DICOM image loader registers — Cornerstone
  // dispatches `wadouri:` URLs to the DICOM loader. The URL after the
  // colon is fetched normally, so our Python /files endpoint serves.
  return files.map((p) => `wadouri:http://127.0.0.1:${port}/files?path=${encodeURIComponent(p)}`);
}

async function open(folder, container, opts = {}) {
  const { forceStack = false, sliceThickness = null, sliceSpacing = null, orientation = null } = opts;
  sourceThickness = Number.isFinite(sliceThickness) ? sliceThickness : null;
  sourceSpacing = Number.isFinite(sliceSpacing) ? sliceSpacing : null;
  sourceOrientation = orientation || null;
  await ensureInitialized();

  // Tear down the previous session cleanly. Without removing the viewport
  // from the tool group first, the tool group holds a dead reference and
  // re-enabling with the same viewport id leaves a grey canvas.
  const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  if (renderingEngine) {
    try { tg?.removeViewports(RENDERING_ENGINE_ID, VIEWPORT_ID); } catch {}
    try { renderingEngine.destroy(); } catch {}
    renderingEngine = null;
  }
  if (currentVolumeId) {
    try { cornerstone.cache.removeVolumeLoadObject(currentVolumeId); } catch {}
    currentVolumeId = null;
  }

  element = container;
  // Clear any canvas/wrapper left behind by a previous engine — if the
  // element was hidden during destroy, Cornerstone's cleanup may skip
  // detaching the <canvas> and the new engine renders to a dead node.
  element.innerHTML = '';
  element.style.width = '100%';
  element.style.height = '100%';
  element.oncontextmenu = (e) => e.preventDefault();

  // Wait for layout — the container was just unhidden and may still have
  // zero dimensions in the current frame.
  await new Promise((r) => requestAnimationFrame(r));

  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  const imageIds = await loadStack(folder);

  // Try volume viewport first — gives us live axial/coronal/sagittal
  // reformats via keyboard shortcuts. Falls back to stack viewer for
  // single-image series, volumes that won't build (mixed orientations),
  // or any series the caller asked to view stack-only (e.g. a derived
  // series that's already been reformatted — re-reformatting it is more
  // confusing than useful).
  let viewport = null;
  let asVolume = false;
  if (imageIds.length >= 3 && !forceStack) {
    try {
      renderingEngine.enableElement({
        viewportId: VIEWPORT_ID,
        type: ViewportType.ORTHOGRAPHIC,
        element,
        defaultOptions: {
          orientation: OrientationAxis.AXIAL,
          background: [0, 0, 0],
        },
      });

      const volumeId = `cornerstoneStreamingImageVolume:${folder}:${Date.now()}`;
      await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
      currentVolumeId = volumeId;

      viewport = renderingEngine.getViewport(VIEWPORT_ID);
      await viewport.setVolumes([{ volumeId }]);
      cornerstone.cache.getVolume(volumeId)?.load();

      asVolume = true;
    } catch (e) {
      console.warn('[viewer] volume failed, falling back to stack:', e);
      renderingEngine.disableElement(VIEWPORT_ID);
    }
  }

  if (!viewport) {
    renderingEngine.enableElement({
      viewportId: VIEWPORT_ID,
      type: ViewportType.STACK,
      element,
    });
    viewport = renderingEngine.getViewport(VIEWPORT_ID);
    await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
  }

  currentViewport = viewport;
  currentIsVolume = asVolume;
  currentOrientation = asVolume ? OrientationAxis.AXIAL : null;
  initialVOI = null;

  renderingEngine.resize(true, true);
  viewport.render();

  // Reattach the tool group to the freshly-enabled viewport — we removed
  // any previous association at teardown, so this is the single add.
  tg?.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(() => {
    try { renderingEngine?.resize(true, true); } catch {}
  });
  resizeObserver.observe(element);

  // Fire state updates whenever the VOI (window/level) changes from the
  // W/L drag tool so the status line below the viewer stays in sync.
  if (voiHandler) element.removeEventListener(cornerstone.Enums.Events.VOI_MODIFIED, voiHandler);
  voiHandler = () => emitState();
  element.addEventListener(cornerstone.Enums.Events.VOI_MODIFIED, voiHandler);

  if (cameraHandler) element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler);
  cameraHandler = () => enforceTrimClamp();
  element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler);
  // After the first render, the viewport's native spacing is queryable.
  // Pick the slab default now and emit state so the UI reflects reality.
  element.addEventListener(
    cornerstone.Enums.Events.IMAGE_RENDERED,
    () => {
      if (currentIsVolume) {
        pickDefaultSlab();
        applySlab();
      } else {
        emitState();
      }
    },
    { once: true },
  );

  // In volume mode, take over the wheel so each notch advances by the
  // current slab spacing (the denominator). At native cornerstone-grid
  // spacing we let StackScrollTool handle it — that preserves the
  // trackpad's fine-grained deltaY accumulation that our one-step-per-event
  // override loses.
  if (wheelHandler) element.removeEventListener('wheel', wheelHandler, true);
  wheelHandler = (e) => {
    if (!currentIsVolume || !currentViewport) return;
    const grid = rawNormalSpacingMm();
    if (slabSpacing <= grid + 0.01) return; // native scroll
    e.preventDefault();
    e.stopPropagation();
    const steps = Math.max(1, Math.round(slabSpacing / grid));
    const dir = e.deltaY > 0 ? 1 : -1;
    currentViewport.scroll(dir * steps);
  };
  element.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

  if (!asVolume) {
    preloadAbort?.abort();
    preloadAbort = new AbortController();
    void preloadStack(imageIds, preloadAbort.signal);
  }

  // Keyboard shortcuts — only active when the viewer is open.
  // a/c/s: axial/coronal/sagittal.
  // [/]: thickness ±1 mm. ⇧[/⇧]: spacing ±1 mm. Both clamped to native floor.
  // Defaults get repicked on first render and on orientation change.
  slabThickness = 1;
  slabSpacing = 1;
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e) => {
    if (!currentIsVolume || !currentViewport) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const orientMap = { a: OrientationAxis.AXIAL, c: OrientationAxis.CORONAL, s: OrientationAxis.SAGITTAL };
    const key = e.key.toLowerCase();
    if (orientMap[key]) {
      e.preventDefault();
      currentOrientation = orientMap[key];
      currentViewport.setOrientation(orientMap[key]);
      currentViewport.render();
      pickDefaultSlab();
      applySlab();
      return;
    }
    // Shift+]/[ adjusts spacing (denominator); plain ]/[ adjusts thickness.
    // e.key already reflects the shifted symbol on US layout: '}' / '{'.
    if (e.key === '}' || (e.shiftKey && e.key === ']')) {
      e.preventDefault();
      slabSpacing = slabSpacing + 1;
      applySlab();
    } else if (e.key === '{' || (e.shiftKey && e.key === '[')) {
      e.preventDefault();
      slabSpacing = Math.max(spacingFloor(), slabSpacing - 1);
      applySlab();
    } else if (e.key === ']') {
      e.preventDefault();
      slabThickness = slabThickness + 1;
      applySlab();
    } else if (e.key === '[') {
      e.preventDefault();
      slabThickness = Math.max(thicknessFloor(), slabThickness - 1);
      applySlab();
    } else if (e.key === ' ') {
      e.preventDefault();
      resetView();
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function applySlab() {
  if (!currentViewport || !currentIsVolume) return;
  // Clamp to native floor in case orientation changed since the value was set.
  slabThickness = Math.max(thicknessFloor(), slabThickness);
  slabSpacing   = Math.max(spacingFloor(),   slabSpacing);
  // At or below the cornerstone voxel grid, render as a composite (single-
  // voxel) slice — averaging below native pretends to a resolution we don't
  // have. Above native, AVERAGE_INTENSITY_BLEND gives a real slab projection.
  const grid = rawNormalSpacingMm();
  if (slabThickness <= grid + 0.01) {
    currentViewport.setBlendMode(BlendModes.COMPOSITE);
    currentViewport.setSlabThickness(0);
  } else {
    currentViewport.setBlendMode(BlendModes.AVERAGE_INTENSITY_BLEND);
    currentViewport.setSlabThickness(slabThickness);
  }
  currentViewport.render();
  emitState();
}

async function preloadStack(imageIds, signal) {
  const { imageLoader } = cornerstone;
  for (const id of imageIds) {
    if (signal.aborted) return;
    try {
      await imageLoader.loadAndCacheImage(id);
    } catch {
      // Individual slice failures are non-fatal — viewer will still
      // render the ones that decoded.
    }
  }
}

function close() {
  preloadAbort?.abort();
  preloadAbort = null;
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  if (wheelHandler && element) {
    element.removeEventListener('wheel', wheelHandler, true);
    wheelHandler = null;
  }
  if (voiHandler && element) {
    try { element.removeEventListener(cornerstone.Enums.Events.VOI_MODIFIED, voiHandler); } catch {}
    voiHandler = null;
  }
  if (cameraHandler && element) {
    try { element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler); } catch {}
    cameraHandler = null;
  }
  trimRange = null;
  if (renderingEngine) {
    renderingEngine.destroy();
    renderingEngine = null;
  }
  if (currentVolumeId) {
    try { cornerstone.cache.removeVolumeLoadObject(currentVolumeId); } catch {}
    currentVolumeId = null;
  }
  element = null;
  currentViewport = null;
  currentIsVolume = false;
}

function applyWindow(center, width) {
  if (!currentViewport || !(width > 0)) return;
  currentViewport.setProperties({
    voiRange: { lower: center - width / 2, upper: center + width / 2 },
  });
  currentViewport.render();
  emitState();
}

function resetView() {
  if (!currentViewport) return;
  // Reset VOI and slab together — the user expects "reset" to give back
  // the same image they saw when the series first opened, which means
  // default window AND the starting-point slab (native spacing).
  currentViewport.resetProperties();
  if (currentIsVolume) {
    pickDefaultSlab();
    applySlab();
  } else {
    currentViewport.render();
    emitState();
  }
}

function setTrimRange(range) {
  trimRange = range && Number.isFinite(range.start) && Number.isFinite(range.end)
    ? { start: range.start, end: range.end }
    : null;
  enforceTrimClamp();
}

function enforceTrimClamp() {
  if (!trimRange || !currentViewport || clampInFlight) return;
  const current = currentViewport.getSliceIndex?.();
  if (current == null) return;
  let target = null;
  if (current < trimRange.start) target = trimRange.start;
  else if (current > trimRange.end) target = trimRange.end;
  if (target == null) return;
  clampInFlight = true;
  try { goToSlice(target); } finally { clampInFlight = false; }
}

function goToSlice(idx) {
  if (!currentViewport || !Number.isFinite(idx)) return;
  const target = Math.round(idx);
  try {
    const v = currentViewport;
    // Stack mode is simple — setImageIdIndex is exposed.
    if (typeof v.setImageIdIndex === 'function') {
      v.setImageIdIndex(target);
      v.render();
      return;
    }
    // Volume mode: scroll returns but doesn't guarantee the target renders
    // when called with large deltas. Instead move the camera's focalPoint
    // along the slice normal so the target slice is exactly at focus.
    if (currentIsVolume && typeof v.getCamera === 'function') {
      const camera = v.getCamera();
      const normal = camera.viewPlaneNormal;
      if (!normal) return;
      // Slider ticks step by the current slabSpacing (the denominator), not
      // the voxel grid — so "slice 5" in coronal at 3/2 mm lands at 10 mm,
      // same feel as axial. Clamp to the volume's extent along this normal.
      const grid = rawNormalSpacingMm();
      const n = currentSliceCount() ?? 1;
      const clamped = Math.max(0, Math.min(n - 1, target));
      const currentSlice = v.getSliceIndex?.() ?? 0;
      const targetVoxel = Math.round(clamped * slabSpacing / grid);
      const delta = (targetVoxel - currentSlice) * grid;
      const fp = camera.focalPoint;
      const pos = camera.position;
      const newFocal = [
        fp[0] + normal[0] * delta,
        fp[1] + normal[1] * delta,
        fp[2] + normal[2] * delta,
      ];
      const newPos = [
        pos[0] + normal[0] * delta,
        pos[1] + normal[1] * delta,
        pos[2] + normal[2] * delta,
      ];
      v.setCamera({ ...camera, focalPoint: newFocal, position: newPos });
      v.render();
      return;
    }
    // Fallback
    const current = v.getCurrentImageIdIndex?.() ?? 0;
    const delta = target - current;
    if (delta !== 0) v.scroll(delta, false);
    v.render();
  } catch (e) {
    console.warn('[viewer] goToSlice failed:', e);
  }
}

window.viewerAPI = { open, close, applyWindow, reset: resetView, goToSlice, setTrimRange };
