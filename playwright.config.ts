import { defineConfig } from '@playwright/test';

// E2E config for Electron-mode tests. We don't drive a browser, so all the
// browser/projects/headless wiring is omitted — tests launch Electron via
// `_electron.launch()` from the `playwright` package.
//
// Tests run serially: each one boots a fresh Electron instance (slow), and
// they touch real backends + sessionStorage, so parallel runs would step on
// each other.
export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  // Electron boot + backend warm-up can comfortably take 10s on a cold
  // machine; default 30s is fine for the smoke pass, bump per-test if a
  // future test needs longer.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? 'github' : 'list',
});
