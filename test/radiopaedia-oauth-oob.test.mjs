// Unit tests for the pure OOB authorization-code exchange core.
//
// The testable helpers live in `radiopaedia-auth-core.ts` (Electron-free).
// The Electron-facing wrapper in `radiopaedia-oauth-oob.ts` just wires
// them to `shell.openExternal` + safeStorage-backed token persistence,
// so there's nothing extra to test there.
//
// Run after `npm run build:frontend` so dist/ is current. Never hit
// radiopaedia.org from tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../dist/main/radiopaedia-auth-core.js');
const {
  exchangeAuthorizationCodeCore,
  buildAuthorizeUrlCore,
  RADIOPAEDIA_AUTHORIZE_URL,
} = mod;

function makeDeps(overrides = {}) {
  const store = { tokens: null, setCalls: 0 };
  const deps = {
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
    now: () => 50_000,
    setTokens: (t) => {
      store.tokens = t;
      store.setCalls += 1;
    },
    getEffectiveClientCredentials: () => ({
      client_id: 'cid',
      client_secret: 'csec',
    }),
    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
    tokenUrl: 'https://test.invalid/token',
    ...overrides,
  };
  return { store, deps };
}

test('buildAuthorizeUrlCore: response_type=code, client_id, redirect_uri, no scope, no PKCE', () => {
  const url = buildAuthorizeUrlCore(
    'my-client-id',
    'urn:ietf:wg:oauth:2.0:oob',
    RADIOPAEDIA_AUTHORIZE_URL,
  );
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://radiopaedia.org/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'my-client-id');
  assert.equal(u.searchParams.get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');
  assert.equal(u.searchParams.get('scope'), null);
  assert.equal(u.searchParams.get('code_challenge'), null);
  assert.equal(u.searchParams.get('code_challenge_method'), null);
});

test('exchangeAuthorizationCodeCore: posts code + creds + urn redirect, persists tokens, returns ok', async () => {
  let capturedUrl = null;
  let capturedInit = null;
  const { store, deps } = makeDeps({
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: 'AT',
            refresh_token: 'RT',
            expires_in: 3600,
            token_type: 'Bearer',
          };
        },
      };
    },
  });

  const result = await exchangeAuthorizationCodeCore('auth-code-xyz', deps);
  assert.equal(result, 'ok');

  assert.equal(capturedUrl, 'https://test.invalid/token');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(
    capturedInit.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  );

  const params = new URLSearchParams(capturedInit.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code'), 'auth-code-xyz');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('client_secret'), 'csec');
  assert.equal(params.get('redirect_uri'), 'urn:ietf:wg:oauth:2.0:oob');

  // Persisted trio includes expires_at = now + expires_in.
  assert.equal(store.setCalls, 1);
  assert.deepEqual(store.tokens, {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: 50_000 + 3600,
    token_type: 'Bearer',
  });
});

test('exchangeAuthorizationCodeCore: returns error on non-2xx, does not persist', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: 'invalid_grant' };
      },
    }),
  });
  const result = await exchangeAuthorizationCodeCore('bad-code', deps);
  assert.equal(result, 'error');
  assert.equal(store.setCalls, 0);
  assert.equal(store.tokens, null);
});

test('exchangeAuthorizationCodeCore: returns error on network failure', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => {
      throw new Error('boom');
    },
  });
  const result = await exchangeAuthorizationCodeCore('some-code', deps);
  assert.equal(result, 'error');
  assert.equal(store.setCalls, 0);
});

test('exchangeAuthorizationCodeCore: returns error on malformed success payload', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'only' };
      },
    }),
  });
  const result = await exchangeAuthorizationCodeCore('some-code', deps);
  assert.equal(result, 'error');
  assert.equal(store.setCalls, 0);
});

test('exchangeAuthorizationCodeCore: error when no client credentials configured', async () => {
  let fetchCalled = false;
  const { store, deps } = makeDeps({
    getEffectiveClientCredentials: () => null,
    fetch: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });
  const result = await exchangeAuthorizationCodeCore('some-code', deps);
  assert.equal(result, 'error');
  assert.equal(fetchCalled, false);
  assert.equal(store.setCalls, 0);
});

test('exchangeAuthorizationCodeCore: empty code rejected without calling fetch', async () => {
  let fetchCalled = false;
  const { store, deps } = makeDeps({
    fetch: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  });
  const result = await exchangeAuthorizationCodeCore('', deps);
  assert.equal(result, 'error');
  assert.equal(fetchCalled, false);
  assert.equal(store.setCalls, 0);
});

test('exchangeAuthorizationCodeCore: persistence failure surfaces as error', async () => {
  const { deps } = makeDeps({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          token_type: 'Bearer',
        };
      },
    }),
    setTokens: () => {
      throw new Error('safeStorage unavailable');
    },
  });
  const result = await exchangeAuthorizationCodeCore('some-code', deps);
  assert.equal(result, 'error');
});
