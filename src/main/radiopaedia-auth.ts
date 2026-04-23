// Radiopaedia OAuth refresh + effective-credentials helper.
//
// Thin Electron-aware wrapper around `radiopaedia-auth-core.ts` — this
// module wires the pure core to the real `credentials.ts` (safeStorage)
// and `radiopaedia-config.ts` (build-time baked values). Tests exercise
// the core directly with a stubbed fetch, so they don't need Electron.
//
// Concurrent `getValidAccessToken` callers serialise onto one inflight
// promise so we don't fire multiple /oauth/token POSTs in parallel —
// Radiopaedia rotates the refresh_token on each success, and parallel
// refreshes would overwrite each other's stored tokens.
//
// Never log tokens or the client_secret.

import {
  clearRadiopaediaTokens,
  getRadiopaediaClientOverride,
  getRadiopaediaTokens,
  setRadiopaediaTokens,
  type RadiopaediaTokens,
} from './credentials';
import {
  RADIOPAEDIA_API_BASE,
  RADIOPAEDIA_CLIENT_ID,
  RADIOPAEDIA_CLIENT_SECRET,
} from './radiopaedia-config';
import {
  getValidAccessTokenCore,
  parseTokenResponseCore,
  REFRESH_MARGIN_SECONDS as CORE_REFRESH_MARGIN,
  resolveEffectiveClientCredentials,
  type AuthCoreDeps,
  type RadiopaediaTokensCore,
} from './radiopaedia-auth-core';

// URLs are derived from RADIOPAEDIA_API_BASE so dev builds can target the
// staging site (https://env-develop.radiopaedia-dev.org) by setting
// RADIOPAEDIA_API_BASE at build time. Prod defaults to radiopaedia.org.
export const RADIOPAEDIA_TOKEN_URL = `${RADIOPAEDIA_API_BASE}/oauth/token`;
export const RADIOPAEDIA_AUTHORIZE_URL = `${RADIOPAEDIA_API_BASE}/oauth/authorize`;
export const RADIOPAEDIA_API_URL = `${RADIOPAEDIA_API_BASE}/api/v1`;
export const REFRESH_MARGIN_SECONDS = CORE_REFRESH_MARGIN;

/**
 * Return the client credentials in effect: user-supplied override (from
 * encrypted storage) wins over the build-time baked values. Returns null
 * if neither is configured.
 */
export function getEffectiveClientCredentials(): {
  client_id: string;
  client_secret: string;
} | null {
  return resolveEffectiveClientCredentials(getRadiopaediaClientOverride(), {
    client_id: RADIOPAEDIA_CLIENT_ID,
    client_secret: RADIOPAEDIA_CLIENT_SECRET,
  });
}

/**
 * Parse a /oauth/token JSON body — re-export of the core parser with the
 * RadiopaediaTokens (not …Core) return type for downstream consumers.
 */
export function parseTokenResponse(
  payload: unknown,
  nowSeconds: number,
): RadiopaediaTokens | null {
  const parsed = parseTokenResponseCore(payload, nowSeconds);
  return parsed as RadiopaediaTokens | null;
}

function liveDeps(): AuthCoreDeps {
  return {
    fetch: (...args) => fetch(...args),
    now: () => Math.floor(Date.now() / 1000),
    getTokens: () => getRadiopaediaTokens() as RadiopaediaTokensCore | null,
    setTokens: (t) => setRadiopaediaTokens(t as RadiopaediaTokens),
    clearTokens: clearRadiopaediaTokens,
    getEffectiveClientCredentials,
    tokenUrl: RADIOPAEDIA_TOKEN_URL,
  };
}

// Concurrency guard: if a refresh is already underway, coalesce onto it.
// Multiple renderer-side callers hitting `getValidAccessToken` back-to-back
// after expiry would otherwise each fire their own POST, and because
// Radiopaedia rotates the refresh_token on every success only one of
// them would end up with a usable pair stored.
let inflightRefresh: Promise<string | null> | null = null;

export async function getValidAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = getValidAccessTokenCore(liveDeps()).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

/** Test-only hook: reset the inflight guard between tests. */
export function __resetInflightForTest(): void {
  inflightRefresh = null;
}
