// Packaged-app smoke. The dev-tree smoke (smoke.spec.ts) runs against the
// repo checkout where every file is reachable, so it cannot catch packaging
// regressions: a missing file in the asar, an `extraResources` filter that
// drops a sidecar import, an asset reference that only fails once everything
// is rolled into Contents/Resources/. This spec exists to catch those.
//
// Skipped automatically when build/mac-arm64/Radiopaedia Studio.app is
// absent — keeps `npm run test:e2e` green for contributors who haven't run
// `npm run pack` yet. CI / release flows should run pack first.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
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

  test('radiopaedia.getApiBase returns the configured https base', async () => {
    const win = await app.firstWindow();
    const apiBase = await win.evaluate(() => {
      const w = window as unknown as {
        radiopaedia: { getApiBase: () => Promise<string> };
      };
      return w.radiopaedia.getApiBase();
    });
    // Don't pin the exact value — staging vs prod builds use different
    // hosts and the value is set at build time. Just guard the contract:
    // it's an https URL with no trailing slash, so the renderer can
    // assemble request URLs by string-concat without surprises.
    expect(apiBase).toMatch(/^https:\/\/[^/]+(\.[^/]+)+$/);
  });

  test('shellBridge.openExternal rejects non-http URLs', async () => {
    const win = await app.firstWindow();
    // The main-side handler whitelists http(s) so a renderer-side bug
    // can't ask main to launch arbitrary file:// or shell URLs. Verify
    // the whitelist actually holds in the packaged binary — preload
    // wiring or a refactor that loosens the regex would silently
    // remove the protection otherwise.
    const result = await win.evaluate(async () => {
      const w = window as unknown as {
        shellBridge: { openExternal: (u: string) => Promise<void> };
      };
      try {
        await w.shellBridge.openExternal('file:///etc/passwd');
        return 'allowed';
      } catch {
        return 'rejected';
      }
    });
    expect(result).toBe('rejected');
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

test.describe('packaged app — auth flow', () => {
  test.skip(!existsSync(APP_BIN), `packaged binary missing — run \`npm run pack\``);

  // Each auth test runs against an isolated --user-data-dir so credentials
  // don't leak between tests or pollute the user's real Radiopaedia Studio
  // tokens. The OS keychain entry that backs safeStorage is shared, but
  // tokens themselves live in userData and are wiped with the tmp dir.
  let app: ElectronApplication;
  let win: Page;
  let userDataDir: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'rp-studio-test-'));
    app = await electron.launch({
      executablePath: APP_BIN,
      args: [`--user-data-dir=${userDataDir}`],
    });
    win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('Open Radiopaedia → calls shell.openExternal with the authorize URL', async () => {
    // Patch electron.shell.openExternal in main so the test can capture the
    // URL the IPC handler builds — using the real implementation would
    // launch the user's browser. Stash the captured URL on globalThis so
    // a follow-up app.evaluate can read it back across the IPC boundary.
    await app.evaluate(({ shell }) => {
      const orig = shell.openExternal;
      (globalThis as Record<string, unknown>).__capturedAuthUrl = null;
      shell.openExternal = async (url: string): Promise<void> => {
        (globalThis as Record<string, unknown>).__capturedAuthUrl = url;
        shell.openExternal = orig;
      };
    });

    await win.locator('#btn-auth').click();
    await expect(win.locator('#auth-modal')).toBeVisible();
    await expect(win.locator('#btn-auth-open')).toBeVisible();
    await win.locator('#btn-auth-open').click();

    const captured = await app.evaluate(
      () => (globalThis as Record<string, unknown>).__capturedAuthUrl as string | null,
    );
    expect(captured, 'shell.openExternal should have been called').toBeTruthy();
    const url = new URL(captured!);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toMatch(/.+/);
    expect(url.searchParams.get('redirect_uri')).toBe('urn:ietf:wg:oauth:2.0:oob');
  });

  test('sign-out clears tokens and flips header button back', async () => {
    // Seed tokens via the same IPC the success path uses, then reload so
    // the renderer re-reads auth state on boot. After reload the header
    // should show the authed treatment, the modal should expose the
    // sign-out button, and clicking it should clear persisted tokens.
    const seedTokens = {
      access_token: 'seeded-access',
      refresh_token: 'seeded-refresh',
      // Far future so getValidAccessToken doesn't try to refresh.
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer' as const,
    };
    await win.evaluate((tokens) => {
      const w = window as unknown as {
        credentials: {
          setRadiopaediaTokens: (t: typeof tokens) => Promise<void>;
        };
      };
      return w.credentials.setRadiopaediaTokens(tokens);
    }, seedTokens);
    await win.reload();
    await expect(win.locator('#drop')).toBeVisible();
    await expect(win.locator('#btn-auth')).toHaveText(/Radiopaedia ✓/);

    await win.locator('#btn-auth').click();
    await expect(win.locator('#auth-modal')).toBeVisible();
    await expect(win.locator('#auth-signed-in')).toBeVisible();
    await win.locator('#btn-auth-signout').click();

    // Sign-out is async (IPC round-trip + UI repaint). Wait for the
    // header to flip rather than asserting immediately.
    await expect(win.locator('#btn-auth')).toHaveText(/Sign in to Radiopaedia/);
    const tokensAfter = await win.evaluate(() => {
      const w = window as unknown as {
        credentials: { getRadiopaediaTokens: () => Promise<unknown> };
      };
      return w.credentials.getRadiopaediaTokens();
    });
    expect(tokensAfter, 'tokens should be cleared after sign-out').toBeNull();
  });

  test('signed-in modal renders profile from /users/current', async () => {
    // Seed tokens so the modal opens in signed-in mode and the renderer
    // fires its /users/current request. Stub that request via page.route
    // so we don't depend on network and so we control the rendered shape.
    await win.route('**/api/v1/users/current', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          login: 'jeremy_test',
          quotas: {
            allowed_draft_cases: 25,
            draft_case_count: 3,
            allowed_unlisted_cases: 10,
            unlisted_case_count: 1,
          },
        }),
      });
    });

    await win.evaluate(() => {
      const w = window as unknown as {
        credentials: {
          setRadiopaediaTokens: (t: unknown) => Promise<void>;
        };
      };
      return w.credentials.setRadiopaediaTokens({
        access_token: 'seeded-access',
        refresh_token: 'seeded-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
      });
    });
    await win.reload();
    await expect(win.locator('#drop')).toBeVisible();
    await win.locator('#btn-auth').click();
    await expect(win.locator('#auth-signed-in')).toBeVisible();
    // The profile block is repainted async after /users/current resolves.
    // Wait for the login line rather than asserting on the loading text.
    await expect(win.locator('.auth-profile-login')).toHaveText(/jeremy_test/);
  });

  test('submit code → success persists tokens and flips state', async () => {
    // exchangeAuthorizationCode fires its /oauth/token POST from main
    // (radiopaedia-oauth-oob.ts), so page.route can't intercept it. Patch
    // globalThis.fetch in main with a request-aware stub that recognises
    // the token endpoint and returns a fake token trio. The closure in
    // radiopaedia-oauth-oob.ts (`fetch: (...args) => fetch(...args)`)
    // resolves `fetch` from the global scope at call time, so the patch
    // takes effect immediately for the next IPC dispatch.
    await app.evaluate(() => {
      const orig = globalThis.fetch;
      const stub = async (input: unknown): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input as { url: string }).url;
        if (url.includes('/oauth/token')) {
          globalThis.fetch = orig;
          return new Response(
            JSON.stringify({
              access_token: 'mock-access',
              refresh_token: 'mock-refresh',
              expires_in: 7200,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return orig(input as RequestInfo);
      };
      globalThis.fetch = stub as typeof fetch;
    });

    await win.locator('#btn-auth').click();
    await expect(win.locator('#auth-modal')).toBeVisible();
    await win.locator('#auth-code-input').fill('fake-code-12345');
    await win.locator('#btn-auth-submit').click();

    // On success the modal flips to the signed-in panel and the header
    // button picks up the authed treatment.
    await expect(win.locator('#auth-signed-in')).toBeVisible();
    await expect(win.locator('#btn-auth')).toHaveText(/Radiopaedia ✓/);
    const tokens = await win.evaluate(() => {
      const w = window as unknown as {
        credentials: { getRadiopaediaTokens: () => Promise<{ access_token: string } | null> };
      };
      return w.credentials.getRadiopaediaTokens();
    });
    expect(tokens?.access_token).toBe('mock-access');
  });

  test('submit code → error renders the inline exchange error', async () => {
    // Same patching strategy as the success test, but return a non-ok
    // response so the IPC handler resolves to 'error' and the renderer
    // surfaces the inline message.
    await app.evaluate(() => {
      const orig = globalThis.fetch;
      const stub = async (input: unknown): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input as { url: string }).url;
        if (url.includes('/oauth/token')) {
          globalThis.fetch = orig;
          return new Response(
            JSON.stringify({ error: 'invalid_grant' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return orig(input as RequestInfo);
      };
      globalThis.fetch = stub as typeof fetch;
    });

    await win.locator('#btn-auth').click();
    await win.locator('#auth-code-input').fill('bad-code');
    await win.locator('#btn-auth-submit').click();

    await expect(win.locator('#auth-exchange-error')).toBeVisible();
    await expect(win.locator('#auth-exchange-error')).toContainText(/Exchange failed/);
    // State should NOT have flipped — still signed-out.
    await expect(win.locator('#btn-auth')).toHaveText(/Sign in to Radiopaedia/);
    await expect(win.locator('#auth-signed-out')).toBeVisible();
  });
});

test.describe('packaged app — sent cases', () => {
  test.skip(!existsSync(APP_BIN), `packaged binary missing — run \`npm run pack\``);

  // Same isolated --user-data-dir pattern as auth-flow: tokens are seeded
  // via IPC and localStorage is seeded via win.evaluate, so no real
  // upload has to run before these tests are meaningful.
  let app: ElectronApplication;
  let win: Page;
  let userDataDir: string;

  // Minimal SentCase entry that matches the renderer's schema (#25).
  // Single job so the summary count is unambiguous when it flips to
  // "1 ready" / "1 processing".
  const SEED_SENT_CASE = {
    v: 1,
    caseId: 12345,
    apiBase: 'https://env-develop.radiopaedia-dev.org',
    title: 'Test seeded case',
    uploadedAt: new Date().toISOString(),
    jobs: [
      {
        studyIdx: 0,
        seriesIdx: 0,
        studyId: 678,
        jobId: 'job-abc',
        lastKnownStatus: null,
        lastCheckedAt: null,
      },
    ],
  };

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'rp-studio-test-'));
    app = await electron.launch({
      executablePath: APP_BIN,
      args: [`--user-data-dir=${userDataDir}`],
    });
    win = await app.firstWindow();
    await expect(win.locator('#drop')).toBeVisible();
    // Seed tokens so checkUploadStatus's getValidAccessToken returns one
    // and the fetch actually fires from main.
    await win.evaluate(() => {
      const w = window as unknown as {
        credentials: { setRadiopaediaTokens: (t: unknown) => Promise<void> };
      };
      return w.credentials.setRadiopaediaTokens({
        access_token: 'seeded-access',
        refresh_token: 'seeded-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
      });
    });
    // Seed localStorage with a SentCase. localStorage is per-origin
    // (file://) and persists across reloads within a session, so this
    // survives the reload below.
    await win.evaluate((entry) => {
      localStorage.setItem('radiopaedia-studio:sent-cases', JSON.stringify([entry]));
    }, SEED_SENT_CASE);
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('opening the panel round-trips check-status and renders ready', async () => {
    // Stub main's fetch for the /image_preparation/ endpoint that
    // checkUploadStatus hits. Returns a 200 with a series.status of
    // 'ready', which the renderer renders as a "1 ready" pill.
    await app.evaluate(() => {
      const orig = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init: unknown): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input as { url: string }).url;
        if (url.includes('/image_preparation/')) {
          return new Response(
            JSON.stringify({
              study: { studyId: 678, series: [] },
              series: { seriesId: 999, status: 'ready' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return orig(input as RequestInfo, init as RequestInit | undefined);
      }) as typeof fetch;
    });

    await win.locator('#btn-sent').click();
    await expect(win.locator('#sent-modal')).toBeVisible();
    // Initial render shows "Status not checked yet" — that's pre-fetch.
    // Once the auto-refresh resolves and updateSentCaseJobStatuses
    // re-renders, the summary flips to "1 ready".
    await expect(win.locator('.sent-row-summary')).toContainText(/1 ready/);
  });

  test('closing the panel cancels an in-flight status check', async () => {
    // Hang the fetch but listen to the abort signal so the test can
    // observe the cancellation. Stash the abort flag on globalThis so
    // a follow-up app.evaluate can read it.
    await app.evaluate(() => {
      const orig = globalThis.fetch;
      (globalThis as Record<string, unknown>).__fetchCalled = false;
      (globalThis as Record<string, unknown>).__fetchAborted = false;
      globalThis.fetch = (async (input: unknown, init: unknown): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input as { url: string }).url;
        if (url.includes('/image_preparation/')) {
          (globalThis as Record<string, unknown>).__fetchCalled = true;
          return new Promise<Response>((_resolve, reject) => {
            const signal = (init as { signal?: AbortSignal })?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                (globalThis as Record<string, unknown>).__fetchAborted = true;
                reject(new Error('aborted'));
              });
            }
            // Never resolve — only the abort path completes the promise.
          });
        }
        return orig(input as RequestInfo, init as RequestInit | undefined);
      }) as typeof fetch;
    });

    await win.locator('#btn-sent').click();
    await expect(win.locator('#sent-modal')).toBeVisible();
    // Wait for the fetch to actually start before closing — otherwise
    // the close races the IPC dispatch and there's nothing to abort.
    await expect
      .poll(async () =>
        app.evaluate(() => (globalThis as Record<string, unknown>).__fetchCalled),
      )
      .toBe(true);

    await win.locator('#btn-sent-close').click();
    await expect(win.locator('#sent-modal')).toBeHidden();

    // The cancel-status-check IPC fires when the modal closes; main
    // aborts the controller, our hung fetch sees the abort and flips
    // the flag. Poll briefly — the abort propagation is async.
    await expect
      .poll(async () =>
        app.evaluate(() => (globalThis as Record<string, unknown>).__fetchAborted),
      )
      .toBe(true);
  });
});
