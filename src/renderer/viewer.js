// Cornerstone 3D stack viewer. Bundled by esbuild into dist/viewer.bundle.js
// and exposed as window.viewerAPI. Renderer calls viewerAPI.open(folder)
// when a thumbnail is clicked.
console.log('[viewer] bundle entry');

import * as cornerstone from '@cornerstonejs/core';
import { init as csToolsInit, ToolGroupManager, StackScrollTool,
         WindowLevelTool, PanTool, ZoomTool, Enums as ToolEnums,
         addTool } from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';

const { Enums, RenderingEngine } = cornerstone;
const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

const RENDERING_ENGINE_ID = 'pacs-anonymizer-engine';
const VIEWPORT_ID = 'stack-viewport';
const TOOL_GROUP_ID = 'pacs-tools';

let initialized = false;
let renderingEngine = null;
let element = null;
let resizeObserver = null;
let preloadAbort = null;

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
  console.log('[viewer] got', imageIds.length, 'imageIds, first:', imageIds[0]);

  const viewport = renderingEngine.getViewport(VIEWPORT_ID);
  console.log('[viewer] calling setStack…');
  try {
    await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
    console.log('[viewer] setStack resolved');
  } catch (e) {
    console.error('[viewer] setStack FAILED:', e);
    throw e;
  }

  const rect = element.getBoundingClientRect();
  console.log('[viewer] canvas size:', rect.width, '×', rect.height);
  // keepCamera: true so the image doesn't get stretched/re-zoomed every
  // time the window resizes.
  renderingEngine.resize(true, true);
  viewport.render();
  console.log('[viewer] rendered');

  const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  tg.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
  console.log('[viewer] tools attached');

  // Re-resize on window / panel size changes — Cornerstone locks onto the
  // element's size when enabled and doesn't follow layout without prompts.
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver(() => {
    try { renderingEngine?.resize(true, true); } catch {}
  });
  resizeObserver.observe(element);

  // Preload the whole stack in the background so scrolling is instant.
  // AbortController so we can cancel if the user closes the viewer mid-load.
  preloadAbort?.abort();
  preloadAbort = new AbortController();
  void preloadStack(imageIds, preloadAbort.signal);
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
  if (renderingEngine) {
    renderingEngine.destroy();
    renderingEngine = null;
  }
  element = null;
}

window.viewerAPI = { open, close };
console.log('[viewer] bundle ready, viewerAPI exposed');
