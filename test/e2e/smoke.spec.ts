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

import { test, expect, _electron as electron } from '@playwright/test';

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
