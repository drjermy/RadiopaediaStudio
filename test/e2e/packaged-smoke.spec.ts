// Packaged-app smoke. The dev-tree smoke (smoke.spec.ts) runs against the
// repo checkout where every file is reachable, so it cannot catch packaging
// regressions: a missing file in the asar, an `extraResources` filter that
// drops a sidecar import, an asset reference that only fails once everything
// is rolled into Contents/Resources/. This spec exists to catch those.
//
// Skipped automatically when build/mac-arm64/Radiopaedia Studio.app is
// absent — keeps `npm run test:e2e` green for contributors who haven't run
// `npm run pack` yet. CI / release flows should run pack first.

import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
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

// Pidfiles live where main writes them: `app.getPath('userData')`. On macOS
// that's ~/Library/Application Support/<productName>/. Hard-coded here
// rather than queried via Electron because these tests run outside the
// Electron context.
const USER_DATA = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Radiopaedia Studio',
);

function readPidfile(name: string): number {
  try {
    return Number.parseInt(readFileSync(path.join(USER_DATA, name), 'utf8').trim(), 10);
  } catch {
    return 0;
  }
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate() as Promise<boolean>;
}

test.describe('packaged app — boot integrity', () => {
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

  test('python and node sidecars respond to /health', async () => {
    const win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();
    // Discover the sidecar ports through the renderer's IPC bridges (the
    // same path the real renderer uses). Then hit /health from the page
    // context — fetch from the test process would work too, but driving
    // it from the page proves the bridge end-to-end.
    const health = await win.evaluate(async () => {
      const w = window as unknown as {
        backend: { getPort: () => Promise<number | null> };
        nodeBackend: { getPort: () => Promise<number | null> };
      };
      const [pyPort, nodePort] = await Promise.all([
        w.backend.getPort(),
        w.nodeBackend.getPort(),
      ]);
      if (!pyPort || !nodePort) return { pyPort, nodePort, py: false, node: false };
      const [pyRes, nodeRes] = await Promise.all([
        fetch(`http://127.0.0.1:${pyPort}/health`),
        fetch(`http://127.0.0.1:${nodePort}/health`),
      ]);
      return { pyPort, nodePort, py: pyRes.ok, node: nodeRes.ok };
    });
    expect(health.pyPort, 'python sidecar port should be exposed via IPC').toBeGreaterThan(0);
    expect(health.nodePort, 'node sidecar port should be exposed via IPC').toBeGreaterThan(0);
    expect(health.py, 'python sidecar /health should be 200').toBe(true);
    expect(health.node, 'node sidecar /health should be 200').toBe(true);
  });

  test('preload exposes every IPC bridge the renderer relies on', async () => {
    const win = await app.firstWindow();
    // Each bridge is keyed on a representative function. If preload silently
    // fails to load (a regression we have hit historically when the asar
    // misses a file), `window.<bridge>` is undefined and the renderer
    // crashes the moment it touches it. Dump everything in one shot so a
    // missing bridge surfaces in one test failure rather than several.
    const exposed = await win.evaluate(() => {
      const w = window as unknown as Record<string, Record<string, unknown>>;
      return {
        backend: typeof w.backend?.getPort === 'function',
        nodeBackend: typeof w.nodeBackend?.getPort === 'function',
        fsBridge: typeof w.fsBridge?.pathForFile === 'function',
        shellBridge: typeof w.shellBridge?.openExternal === 'function',
        dialogBridge: typeof w.dialogBridge?.pickFolder === 'function',
        credentials: typeof w.credentials?.getRadiopaediaTokens === 'function',
        radiopaedia: typeof w.radiopaedia?.getValidAccessToken === 'function',
        uploadBridge: typeof w.uploadBridge?.startImages === 'function',
      };
    });
    expect(exposed).toEqual({
      backend: true,
      nodeBackend: true,
      fsBridge: true,
      shellBridge: true,
      dialogBridge: true,
      credentials: true,
      radiopaedia: true,
      uploadBridge: true,
    });
  });
});

test.describe('packaged app — process lifecycle', () => {
  test.skip(!existsSync(APP_BIN), `packaged binary missing — run \`npm run pack\``);

  // These tests manage their own app lifecycle: one closes early, the other
  // SIGKILLs the main process, so the shared beforeEach/afterEach pattern
  // doesn't fit.

  test('clean app close leaves no orphan sidecars', async () => {
    const app = await electron.launch({ executablePath: APP_BIN });
    const win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();
    // Wait for the IPC bridge to confirm both sidecars finished startup —
    // otherwise the pidfile read can race the python-manager / node-manager
    // writeSidecarPid calls.
    await win.evaluate(async () => {
      const w = window as unknown as {
        backend: { getPort: () => Promise<number | null> };
        nodeBackend: { getPort: () => Promise<number | null> };
      };
      await w.backend.getPort();
      await w.nodeBackend.getPort();
    });
    const pyPid = readPidfile('python-sidecar.pid');
    const nodePid = readPidfile('node-sidecar.pid');
    expect(pyPid, 'python pidfile should exist after boot').toBeGreaterThan(0);
    expect(nodePid, 'node pidfile should exist after boot').toBeGreaterThan(0);

    await app.close();

    // SIGTERM is async; give the OS a moment to reap the children before
    // asserting. The before-quit handler in main fires first, so 1s is
    // generous.
    expect(await waitUntil(() => !isAlive(pyPid), 2000)).toBe(true);
    expect(await waitUntil(() => !isAlive(nodePid), 2000)).toBe(true);
  });

  test('next launch reaps sidecars left by SIGKILL', async () => {
    const a = await electron.launch({ executablePath: APP_BIN });
    const winA = await a.firstWindow();
    await expect(winA.locator('#drop')).toBeVisible();
    await winA.evaluate(async () => {
      const w = window as unknown as {
        backend: { getPort: () => Promise<number | null> };
        nodeBackend: { getPort: () => Promise<number | null> };
      };
      await w.backend.getPort();
      await w.nodeBackend.getPort();
    });
    const oldPyPid = readPidfile('python-sidecar.pid');
    const oldNodePid = readPidfile('node-sidecar.pid');
    expect(oldPyPid).toBeGreaterThan(0);
    expect(oldNodePid).toBeGreaterThan(0);

    // SIGKILL the main process so before-quit never fires. Sidecars become
    // orphans — the exact failure mode the reaper exists to clean up.
    // Capture the pid BEFORE the kill: Playwright drops its process
    // reference once the child dies, and `a.process()` then throws.
    const mainPid = a.process().pid ?? 0;
    a.process().kill('SIGKILL');
    expect(await waitUntil(() => !isAlive(mainPid), 2000)).toBe(true);
    // Sidecars should still be alive at this point — they're orphans, not
    // killed by the parent's death.
    expect(isAlive(oldPyPid), 'python orphan should outlive SIGKILL of parent').toBe(true);
    expect(isAlive(oldNodePid), 'node orphan should outlive SIGKILL of parent').toBe(true);

    // Fresh launch — the reaper in startBackend / startNodeSidecar should
    // kill the orphans before the new sidecars come up.
    const b = await electron.launch({ executablePath: APP_BIN });
    try {
      const winB = await b.firstWindow();
      await expect(winB.locator('#drop')).toBeVisible();
      // Reap is awaited inside startBackend, so by the time the window
      // renders the orphans are already gone — but allow a small grace
      // window for SIGKILL escalation in the rare case SIGTERM didn't
      // work.
      expect(await waitUntil(() => !isAlive(oldPyPid), 2000)).toBe(true);
      expect(await waitUntil(() => !isAlive(oldNodePid), 2000)).toBe(true);
    } finally {
      await b.close();
    }
  });
});
