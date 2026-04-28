// Packaged-app smoke. The dev-tree smoke (smoke.spec.ts) runs against the
// repo checkout where every file is reachable, so it cannot catch packaging
// regressions: a missing file in the asar, an `extraResources` filter that
// drops a sidecar import, an asset reference that only fails once everything
// is rolled into Contents/Resources/. This spec exists to catch those.
//
// Skipped automatically when build/mac-arm64/Radiopaedia Studio.app is
// absent — keeps `npm run test:e2e` green for contributors who haven't run
// `npm run pack` yet. CI / release flows should run pack first.
//
// Runs the actual .app binary (not `electron .` against the source tree),
// listens for any failed file:// request from the renderer, and walks the
// Sign-in modal happy path to guard against the regression class where the
// header button silently does nothing because a JS module failed to load.

import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import { existsSync } from 'fs';
import * as path from 'path';

const APP_BIN = path.join(
  process.cwd(),
  'build',
  'mac-arm64',
  'Radiopaedia Studio.app',
  'Contents',
  'MacOS',
  'Radiopaedia Studio',
);

test.describe('packaged app', () => {
  test.skip(!existsSync(APP_BIN), `packaged binary missing — run \`npm run pack\``);

  // Per-test app handle so afterEach can close it even if an assertion
  // throws mid-test (otherwise the Electron process would leak).
  let app: ElectronApplication;
  // Captured during boot so each test can assert on them. file:// failures
  // are renderer asset-load problems (missing JS, missing CSS, missing
  // module from an asar filter regression). pageerror catches uncaught
  // exceptions in the renderer.
  let fileRequestFailures: string[];
  let pageErrors: string[];

  test.beforeEach(async () => {
    fileRequestFailures = [];
    pageErrors = [];
    app = await electron.launch({ executablePath: APP_BIN });
    const win = await app.firstWindow();
    win.on('requestfailed', (req) => {
      const url = req.url();
      // Only file:// matters for packaging-regression detection. http(s)
      // failures here would be unrelated (the sidecars use loopback ports
      // we don't probe in this spec).
      if (url.startsWith('file://')) {
        fileRequestFailures.push(`${url} :: ${req.failure()?.errorText ?? 'unknown'}`);
      }
    });
    win.on('pageerror', (e) => pageErrors.push(e.message));
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('boot loads every renderer asset', async () => {
    const win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();
    // Give the renderer a beat to finish dynamic imports (viewer bundle,
    // shared modules) before asserting no failures.
    await win.waitForLoadState('networkidle');
    expect(fileRequestFailures, 'failed file:// requests during boot').toEqual([]);
    expect(pageErrors, 'uncaught renderer errors during boot').toEqual([]);
  });

  test('header sign-in button opens the auth modal', async () => {
    const win = await app.firstWindow();
    await expect(win.locator('#btn-auth')).toHaveText(/Sign in to Radiopaedia|Radiopaedia ✓/);
    // Modal starts hidden. The previous regression: a missing
    // src/shared/api.js in the asar broke renderer JS so the button's
    // click handler was never bound — the button rendered fine but
    // nothing happened. expect.toBeVisible drives that check directly.
    await expect(win.locator('#auth-modal')).toBeHidden();
    await win.locator('#btn-auth').click();
    await expect(win.locator('#auth-modal')).toBeVisible();
    // The modal renders one of two panels depending on whether the user
    // has a valid token cached: #auth-signed-out (the "Open Radiopaedia"
    // flow) or #auth-signed-in (the profile readout). Assert exactly one
    // is visible rather than picking one, so the test is independent of
    // cached auth state.
    const signedOutVisible = await win.locator('#auth-signed-out').isVisible();
    const signedInVisible = await win.locator('#auth-signed-in').isVisible();
    expect(signedOutVisible !== signedInVisible, 'exactly one auth panel should be visible').toBe(true);
  });
});
