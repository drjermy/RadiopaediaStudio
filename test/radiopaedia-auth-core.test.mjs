// Unit tests for src/main/radiopaedia-auth-core.ts.
//
// The core module is deliberately Electron-free (no `electron` / `app` /
// `safeStorage` imports) so Node's built-in test runner can load it
// directly from the tsc output in `dist/main/`. Tests run after
// `npm run build:frontend`.
//
// Never hit radiopaedia.org from tests — we inject a stubbed `fetch`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../dist/main/radiopaedia-auth-core.js');
const {
  getValidAccessTokenCore,
  parseTokenResponseCore,
  resolveEffectiveClientCredentials,
  REFRESH_MARGIN_SECONDS,
} = mod;

// ---------- resolveEffectiveClientCredentials ----------

test('resolveEffectiveClientCredentials: override wins over baked values', () => {
  const result = resolveEffectiveClientCredentials(
    { client_id: 'ovr_id', client_secret: 'ovr_secret' },
    { client_id: 'baked_id', client_secret: 'baked_secret' },
  );
  assert.deepEqual(result, { client_id: 'ovr_id', client_secret: 'ovr_secret' });
});

test('resolveEffectiveClientCredentials: falls back to baked when no override', () => {
  const result = resolveEffectiveClientCredentials(null, {
    client_id: 'baked_id',
    client_secret: 'baked_secret',
  });
  assert.deepEqual(result, { client_id: 'baked_id', client_secret: 'baked_secret' });
});

test('resolveEffectiveClientCredentials: empty override strings do not win', () => {
  const result = resolveEffectiveClientCredentials(
    { client_id: '', client_secret: '' },
    { client_id: 'baked_id', client_secret: 'baked_secret' },
  );
  assert.deepEqual(result, { client_id: 'baked_id', client_secret: 'baked_secret' });
});

test('resolveEffectiveClientCredentials: half-set override is not used', () => {
  // A stray override with only one field set should not partially override —
  // we fall through to the baked pair instead.
  const result = resolveEffectiveClientCredentials(
    { client_id: 'ovr_id', client_secret: '' },
    { client_id: 'baked_id', client_secret: 'baked_secret' },
  );
  assert.deepEqual(result, { client_id: 'baked_id', client_secret: 'baked_secret' });
});

test('resolveEffectiveClientCredentials: returns null when nothing configured', () => {
  const result = resolveEffectiveClientCredentials(null, {
    client_id: '',
    client_secret: '',
  });
  assert.equal(result, null);
});

// ---------- parseTokenResponseCore ----------

test('parseTokenResponseCore: valid payload produces tokens with expires_at', () => {
  const now = 1_000;
  const parsed = parseTokenResponseCore(
    {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_in: 7200,
      token_type: 'Bearer',
    },
    now,
  );
  assert.deepEqual(parsed, {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: now + 7200,
    token_type: 'Bearer',
  });
});

test('parseTokenResponseCore: rejects missing fields', () => {
  assert.equal(parseTokenResponseCore({}, 0), null);
  assert.equal(
    parseTokenResponseCore({ access_token: 'a', refresh_token: 'r' }, 0),
    null,
  );
  assert.equal(
    parseTokenResponseCore({ access_token: '', refresh_token: 'r', expires_in: 1 }, 0),
    null,
  );
  assert.equal(parseTokenResponseCore(null, 0), null);
  assert.equal(parseTokenResponseCore('nope', 0), null);
});

// ---------- getValidAccessTokenCore ----------

function makeDeps(overrides = {}) {
  const store = { tokens: null, setCalls: 0, clearCalls: 0 };
  const base = {
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
    now: () => 10_000,
    getTokens: () => store.tokens,
    setTokens: (t) => {
      store.tokens = t;
      store.setCalls += 1;
    },
    clearTokens: () => {
      store.tokens = null;
      store.clearCalls += 1;
    },
    getEffectiveClientCredentials: () => ({
      client_id: 'cid',
      client_secret: 'csec',
    }),
    tokenUrl: 'https://test.invalid/token',
    ...overrides,
  };
  return { store, deps: base };
}

test('getValidAccessTokenCore: returns null when no tokens stored', async () => {
  const { deps } = makeDeps();
  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
});

test('getValidAccessTokenCore: returns cached token when expiry is outside margin', async () => {
  const { store, deps } = makeDeps();
  store.tokens = {
    access_token: 'cached',
    refresh_token: 'r',
    expires_at: 10_000 + REFRESH_MARGIN_SECONDS + 600,
    token_type: 'Bearer',
  };
  // fetch stub would throw — passing proves we never called it.
  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, 'cached');
});

test('getValidAccessTokenCore: refreshes when within margin and stores rotated trio', async () => {
  let fetchedUrl = null;
  let fetchedBody = null;
  const { store, deps } = makeDeps({
    fetch: async (url, init) => {
      fetchedUrl = url;
      fetchedBody = init.body;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: 'a2',
            refresh_token: 'r2',
            expires_in: 7200,
            token_type: 'Bearer',
          };
        },
      };
    },
  });
  store.tokens = {
    access_token: 'a1',
    refresh_token: 'r1_old',
    expires_at: 10_000 + 30, // within margin (default 60)
    token_type: 'Bearer',
  };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, 'a2');
  assert.equal(fetchedUrl, 'https://test.invalid/token');
  // Form-encoded body must include grant_type, refresh_token (old), client creds.
  const params = new URLSearchParams(fetchedBody);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'r1_old');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.get('client_secret'), 'csec');
  // Rotated trio is persisted.
  assert.equal(store.tokens.access_token, 'a2');
  assert.equal(store.tokens.refresh_token, 'r2');
  assert.equal(store.tokens.expires_at, 10_000 + 7200);
  assert.equal(store.setCalls, 1);
  assert.equal(store.clearCalls, 0);
});

test('getValidAccessTokenCore: 4xx refresh response clears stored tokens and returns null', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => ({
      ok: false,
      status: 401,
      async json() {
        return {};
      },
    }),
  });
  store.tokens = {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 10_000 + 10,
    token_type: 'Bearer',
  };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
  assert.equal(store.tokens, null);
  assert.equal(store.clearCalls, 1);
  assert.equal(store.setCalls, 0);
});

test('getValidAccessTokenCore: 5xx refresh response leaves tokens in place', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      },
    }),
  });
  const original = {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 10_000 + 10,
    token_type: 'Bearer',
  };
  store.tokens = { ...original };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
  // Stored tokens unchanged — user may retry, network may recover.
  assert.deepEqual(store.tokens, original);
  assert.equal(store.clearCalls, 0);
});

test('getValidAccessTokenCore: network failure leaves tokens in place', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => {
      throw new Error('boom');
    },
  });
  store.tokens = {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 10_000 + 10,
    token_type: 'Bearer',
  };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
  assert.equal(store.clearCalls, 0);
  assert.equal(store.tokens.access_token, 'a1');
});

test('getValidAccessTokenCore: returns null (no refresh) when no client credentials configured', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
    getEffectiveClientCredentials: () => null,
  });
  store.tokens = {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 10_000 + 10,
    token_type: 'Bearer',
  };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
  // Tokens preserved — configuring creds + retrying should still work.
  assert.equal(store.tokens.access_token, 'a1');
  assert.equal(store.clearCalls, 0);
});

test('getValidAccessTokenCore: malformed refresh-success payload leaves tokens in place', async () => {
  const { store, deps } = makeDeps({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { access_token: 'only' };
      },
    }),
  });
  const original = {
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 10_000 + 10,
    token_type: 'Bearer',
  };
  store.tokens = { ...original };

  const out = await getValidAccessTokenCore(deps);
  assert.equal(out, null);
  assert.deepEqual(store.tokens, original);
});
