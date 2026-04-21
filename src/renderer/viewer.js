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

const SLAB_STEPS = [1, 2, 3, 5, 10]; // mm

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
let slabIdx = 0;

function nativeSpacingMm() {
  if (!currentViewport) return 1;
  try { return currentViewport.getSpacingInNormalDirection?.() ?? 1; } catch { return 1; }
}

function effectiveSlab() {
  // Requested thickness is floored to the native voxel spacing along the
  // current slice normal — we can't meaningfully render thinner than the
  // acquisition. Reports both the effective mm and whether we hit the floor.
  const requested = SLAB_STEPS[slabIdx];
  const native = nativeSpacingMm();
  const mm = Math.max(requested, native);
  return { requested, native, mm, isNative: requested <= native };
}

function pickDefaultSlabIdx() {
  // Start at the smallest SLAB_STEPS entry ≥ native voxel spacing — so
  // a 3 mm CT opens at 3 mm by default, not a misleading 1 mm.
  const native = nativeSpacingMm();
  for (let i = 0; i < SLAB_STEPS.length; i++) {
    if (SLAB_STEPS[i] >= native) return i;
  }
  return SLAB_STEPS.length - 1;
}

// Remember the first seen VOI so we can tell "untouched" from "user
// dragged W/L back to the same numbers" — used by Save.
let initialVOI = null;

function emitState() {
  if (!currentViewport) return;
  const props = currentViewport.getProperties?.() ?? {};
  const voi = props.voiRange || {};
  const hasVOI = voi.upper != null && voi.lower != null;
  const slab = currentIsVolume ? effectiveSlab() : null;

  const center = hasVOI ? (voi.upper + voi.lower) / 2 : null;
  const width  = hasVOI ? voi.upper - voi.lower        : null;
  if (hasVOI && !initialVOI) initialVOI = { center, width };
  const isDefaultVOI = hasVOI && initialVOI
    ? Math.abs(center - initialVOI.center) < 0.5
      && Math.abs(width - initialVOI.width) < 0.5
    : true;

  const isDefaultView = currentIsVolume
    ? currentOrientation === OrientationAxis.AXIAL
      && slab?.isNative === true
    : true;

  document.dispatchEvent(new CustomEvent('viewer:state', {
    detail: {
      isVolume: currentIsVolume,
      orientation: currentOrientation,
      slabMm: slab?.mm ?? null,
      slabIsNative: slab?.isNative ?? false,
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
  const { forceStack = false } = opts;
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

      const volumeId = `cornerstoneStreamingImageVolume:${folder}`;
      await volumeLoader.createAndCacheVolume(volumeId, { imageIds });

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
        slabIdx = pickDefaultSlabIdx();
        applySlab();
      } else {
        emitState();
      }
    },
    { once: true },
  );

  // In volume mode with a thick slab, take over the wheel so each notch
  // advances by the slab thickness (3 mm slab → 3 mm step). At 1 mm we
  // let StackScrollTool handle scrolling natively — this preserves the
  // trackpad's fine-grained deltaY accumulation which our simple
  // one-step-per-event override loses.
  if (wheelHandler) element.removeEventListener('wheel', wheelHandler, true);
  wheelHandler = (e) => {
    if (!currentIsVolume || !currentViewport) return;
    const { mm, isNative } = effectiveSlab();
    if (isNative) return; // native scroll — let StackScrollTool handle it
    e.preventDefault();
    e.stopPropagation();
    const normalSpacing = nativeSpacingMm();
    const steps = Math.max(1, Math.round(mm / normalSpacing));
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
  // a/c/s: axial/coronal/sagittal. ]/[ step slab thickness through 1/2/3/5/10 mm.
  // Slab default starts at index 0; we re-pick it after the first render
  // (the viewport's getSpacingInNormalDirection isn't reliable until then).
  slabIdx = 0;
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
      emitState();
      return;
    }
    if (e.key === ']') {
      e.preventDefault();
      slabIdx = Math.min(slabIdx + 1, SLAB_STEPS.length - 1);
      applySlab();
    } else if (e.key === '[') {
      e.preventDefault();
      slabIdx = Math.max(slabIdx - 1, 0);
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
  const { mm, isNative } = effectiveSlab();
  // If the requested thickness is at or below the native voxel, render as
  // a composite (single-voxel) slice — averaging below native pretends to
  // a resolution we don't have. Above native, AVERAGE_INTENSITY_BLEND
  // gives a meaningful slab projection.
  if (isNative) {
    currentViewport.setBlendMode(BlendModes.COMPOSITE);
    currentViewport.setSlabThickness(0);
  } else {
    currentViewport.setBlendMode(BlendModes.AVERAGE_INTENSITY_BLEND);
    currentViewport.setSlabThickness(mm);
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
    slabIdx = pickDefaultSlabIdx();
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
      const spacing = nativeSpacingMm();
      // Total slices along this orientation — infer from imageIds length,
      // which matches the acquisition count in the common case.
      const imageIds = v.getImageIds?.() ?? [];
      const n = imageIds.length || 1;
      const clamped = Math.max(0, Math.min(n - 1, target));
      // Compute the camera shift needed. We use the current focalPoint as
      // reference, derive where slice 0 sits, then jump to the target slice.
      const currentSlice = v.getSliceIndex?.() ?? 0;
      const delta = (clamped - currentSlice) * spacing;
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
