// Minimum-viable Electron smoke test.
//
// Boots the packaged renderer (must have been built — `npm run build:frontend`
// is the test:e2e prerequisite, see the npm script), checks that the main
// window opens, the app shell rendered, and the idle drop zone is visible.
// Closes cleanly.
//
// Intentionally does NOT walk the anonymise → upload happy path: that needs
// DICOM fixtures and the Python+Node sidecars warmed up. We extend this file
// once the upload pipeline lands.

import { test, expect, _electron as electron, Page } from '@playwright/test';

// Playwright runs from the repo root, so process.cwd() is the right place
// to point Electron at — the main field in package.json (dist/main/index.js)
// resolves from here.
const repoRoot = process.cwd();

test('app boots and shows the idle drop zone', async () => {
  const app = await electron.launch({
    args: [repoRoot],
    cwd: repoRoot,
  });

  try {
    const win = await app.firstWindow();
    // The window's "load" event has fired by the time firstWindow() resolves,
    // but Electron's renderer JS may still be wiring up. Wait for the drop
    // zone — it's the last thing the boot path renders before settling into
    // the idle state, so seeing it means the renderer didn't crash on import.
    await expect(win.locator('#drop')).toBeVisible();
    await expect(win.locator('.app-header h1')).toHaveText('Radiopaedia Studio');
    // Idle state means the Open Folder button is shown and Clear is hidden.
    await expect(win.locator('#btn-open-folder')).toBeVisible();
    await expect(win.locator('#btn-reset')).toBeHidden();
  } finally {
    await app.close();
  }
});

// Helper: parse `rgb(r, g, b)` / `rgba(r, g, b, a)` into perceptual luminance
// (Rec. 709 weights, scaled 0–255). Used for "is this dark or light" checks
// without committing to a specific colour value (we only care that the page
// adapts, not the exact shade).
function luminance(rgb: string): number {
  const m = rgb.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.slice(0, 3).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Probe the resolved colour of an injected element using the CSS Color 4
// keywords `Canvas` / `CanvasText`. These are what the modal and typeahead
// menu use, and are the right surface to check — body text colour can flip
// via emulateMedia even when the canvas paint doesn't, but Canvas/CanvasText
// resolve via the same OS-driven path that paints the canvas, so they're a
// faithful proxy for what the user actually sees.
async function canvasProbe(win: Page): Promise<{ bg: string; fg: string }> {
  return win.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;background:Canvas;color:CanvasText;';
    probe.textContent = 'probe';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = { bg: cs.backgroundColor, fg: cs.color };
    probe.remove();
    return out;
  });
}

// The renderer relies on `color-scheme: light dark` + Canvas/CanvasText so
// the modal, dropdowns, and any future themed surfaces flip with the OS
// preference. This test guards that contract by emulating each scheme and
// asserting Canvas/CanvasText resolve to the corresponding luminance band.
// Without this, a refactor that swaps Canvas/CanvasText back to hard-coded
// `--bg, #fff` (which we fixed in 184df57) would silently regress.
//
// Both schemes share one Electron launch — we couldn't get a reliable
// per-scheme launch using nativeTheme.themeSource (the page reference
// closed mid-test), and emulateMedia is sufficient because Canvas /
// CanvasText resolve from prefers-color-scheme matchMedia at lookup time.
test('renderer adapts Canvas/CanvasText to OS color-scheme', async () => {
  const app = await electron.launch({ args: [repoRoot], cwd: repoRoot });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();

    await win.emulateMedia({ colorScheme: 'dark' });
    const dark = await canvasProbe(win);
    expect(luminance(dark.bg)).toBeLessThan(96);
    expect(luminance(dark.fg)).toBeGreaterThan(160);

    await win.emulateMedia({ colorScheme: 'light' });
    const light = await canvasProbe(win);
    expect(luminance(light.bg)).toBeGreaterThan(160);
    expect(luminance(light.fg)).toBeLessThan(96);
  } finally {
    await app.close();
  }
});
