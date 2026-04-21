// Cornerstone 3D stack viewer. Bundled by esbuild into dist/viewer.bundle.js
// and exposed as window.viewerAPI. Renderer calls viewerAPI.open(folder)
// when a thumbnail is clicked.
console.log('[viewer] bundle entry');

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
let slabIdx = 0;

function emitState() {
  if (!currentViewport) return;
  const props = currentViewport.getProperties?.() ?? {};
  const voi = props.voiRange || {};
  const hasVOI = voi.upper != null && voi.lower != null;
  document.dispatchEvent(new CustomEvent('viewer:state', {
    detail: {
      isVolume: currentIsVolume,
      orientation: currentOrientation,
      slabMm: SLAB_STEPS[slabIdx],
      center: hasVOI ? (voi.upper + voi.lower) / 2 : null,
      width: hasVOI ? voi.upper - voi.lower : null,
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

async function open(folder, container) {
  console.log('[viewer] open() start folder=', folder);
  await ensureInitialized();
  console.log('[viewer] init done');

  element = container;
  element.style.width = '100%';
  element.style.height = '100%';
  element.oncontextmenu = (e) => e.preventDefault();

  await new Promise((r) => requestAnimationFrame(r));
  const rect0 = element.getBoundingClientRect();
  console.log('[viewer] container size after rAF:', rect0.width, '×', rect0.height);

  if (renderingEngine) renderingEngine.destroy();
  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
  console.log('[viewer] rendering engine created');

  const viewportInput = {
    viewportId: VIEWPORT_ID,
    type: ViewportType.STACK,
    element,
  };
  renderingEngine.enableElement(viewportInput);
  console.log('[viewer] viewport enabled');

  const imageIds = await loadStack(folder);
  console.log('[viewer] got', imageIds.length, 'imageIds');

  // Try volume viewport first — gives us live axial/coronal/sagittal
  // reformats via keyboard shortcuts. Falls back to stack viewer for
  // single-image series or volumes that won't build (mixed orientations).
  let viewport = null;
  let asVolume = false;
  if (imageIds.length >= 3) {
    try {
      const viewportInput = {
        viewportId: VIEWPORT_ID,
        type: ViewportType.ORTHOGRAPHIC,
        element,
        defaultOptions: {
          orientation: OrientationAxis.AXIAL,
          background: [0, 0, 0],
        },
      };
      renderingEngine.enableElement(viewportInput);

      const volumeId = `cornerstoneStreamingImageVolume:${folder}`;
      console.log('[viewer] creating volume…');
      await volumeLoader.createAndCacheVolume(volumeId, { imageIds });

      viewport = renderingEngine.getViewport(VIEWPORT_ID);
      await viewport.setVolumes([{ volumeId }]);

      const vol = cornerstone.cache.getVolume(volumeId);
      vol?.load();  // stream-fill the volume in the background

      asVolume = true;
      console.log('[viewer] volume viewport ready');
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
    try {
      await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
    } catch (e) {
      console.error('[viewer] setStack FAILED:', e);
      throw e;
    }
  }

  currentViewport = viewport;
  currentIsVolume = asVolume;
  currentOrientation = asVolume ? OrientationAxis.AXIAL : null;

  renderingEngine.resize(true, true);
  viewport.render();
  console.log('[viewer] rendered', asVolume ? '(volume)' : '(stack)');

  const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  tg.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

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
  // Also emit once images have rendered — gives the status line an initial
  // W/L reading from whatever the default presentation was.
  element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, () => emitState(), { once: true });

  // In volume mode with a thick slab, take over the wheel so each notch
  // advances by the slab thickness (3 mm slab → 3 mm step). At 1 mm we
  // let StackScrollTool handle scrolling natively — this preserves the
  // trackpad's fine-grained deltaY accumulation which our simple
  // one-step-per-event override loses.
  if (wheelHandler) element.removeEventListener('wheel', wheelHandler, true);
  wheelHandler = (e) => {
    if (!currentIsVolume || !currentViewport) return;
    if (slabIdx === 0) return; // native scroll
    e.preventDefault();
    e.stopPropagation();
    const mm = SLAB_STEPS[slabIdx];
    let normalSpacing = 1;
    try {
      normalSpacing = currentViewport.getSpacingInNormalDirection?.() ?? 1;
    } catch {}
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
  // a/c/s: axial/coronal/sagittal. ]/[ step slab thickness through 1/3/5/10 mm.
  slabIdx = 0;
  applySlab();
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
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function applySlab() {
  if (!currentViewport || !currentIsVolume) return;
  const mm = SLAB_STEPS[slabIdx];
  // At 1 mm, render as a normal slice via composite blend. Above 1 mm,
  // average the slab so the intensity is meaningful (neutral choice vs
  // MIP/MinIP which have their own uses).
  if (mm <= 1) {
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
  let loaded = 0;
  for (const id of imageIds) {
    if (signal.aborted) return;
    try {
      await imageLoader.loadAndCacheImage(id);
      loaded += 1;
      if (loaded === 1 || loaded % 50 === 0 || loaded === imageIds.length) {
        console.log(`[viewer] preloaded ${loaded}/${imageIds.length}`);
      }
    } catch (e) {
      console.warn('[viewer] preload failed for', id, e);
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
  if (renderingEngine) {
    renderingEngine.destroy();
    renderingEngine = null;
  }
  element = null;
  currentViewport = null;
  currentIsVolume = false;
}

window.viewerAPI = { open, close };
console.log('[viewer] bundle ready, viewerAPI exposed');
