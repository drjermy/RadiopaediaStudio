// Pure, Electron-free core of the Radiopaedia auth helper.
//
// Lives in its own module so Node test runners can exercise the refresh
// branching and token-response parsing without dragging in `electron`
// (which `credentials.ts` and therefore `radiopaedia-auth.ts` do).
//
// No logging of tokens or client_secret.

export const RADIOPAEDIA_TOKEN_URL = 'https://radiopaedia.org/oauth/token';
export const RADIOPAEDIA_AUTHORIZE_URL = 'https://radiopaedia.org/oauth/authorize';

// Refresh if the stored access token expires within this many seconds.
export const REFRESH_MARGIN_SECONDS = 60;

export interface RadiopaediaTokensCore {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: 'Bearer';
}

export interface ClientOverrideCore {
  client_id: string;
  client_secret: string;
}

export interface BakedClientConfig {
  client_id: string;
  client_secret: string;
}

/**
 * Override wins over the build-time baked values. Empty strings count as
 * "not configured" on both sides. Returns null if neither is configured.
 */
export function resolveEffectiveClientCredentials(
  override: ClientOverrideCore | null,
  baked: BakedClientConfig,
): { client_id: string; client_secret: string } | null {
  if (override && override.client_id !== '' && override.client_secret !== '') {
    return { client_id: override.client_id, client_secret: override.client_secret };
  }
  if (baked.client_id !== '' && baked.client_secret !== '') {
    return { client_id: baked.client_id, client_secret: baked.client_secret };
  }
  return null;
}

/**
 * Parse a successful /oauth/token JSON body into a tokens record. Returns
 * null if any required field is missing or malformed.
 */
export function parseTokenResponseCore(
  payload: unknown,
  nowSeconds: number,
): RadiopaediaTokensCore | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const access = p.access_token;
  const refresh = p.refresh_token;
  const expiresIn = p.expires_in;
  if (typeof access !== 'string' || access === '') return null;
  if (typeof refresh !== 'string' || refresh === '') return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: nowSeconds + Math.floor(expiresIn),
    token_type: 'Bearer',
  };
}

export interface AuthCoreDeps {
  fetch: typeof fetch;
  now: () => number; // epoch seconds
  getTokens: () => RadiopaediaTokensCore | null;
  setTokens: (t: RadiopaediaTokensCore) => void;
  clearTokens: () => void;
  getEffectiveClientCredentials: () =>
    | { client_id: string; client_secret: string }
    | null;
  // Injection seam so tests don't have to hard-code the live URL.
  tokenUrl?: string;
  marginSeconds?: number;
}

/**
 * Core of `getValidAccessToken`:
 *   - No stored tokens -> null.
 *   - Not within the refresh margin -> return stored access_token.
 *   - Within margin but no client creds -> null (leave tokens in place).
 *   - Within margin: POST grant_type=refresh_token; on success persist
 *     the rotated trio and return the new access_token. On 4xx clear the
 *     store. On 5xx / network / bad payload leave the store alone.
 */
export async function getValidAccessTokenCore(deps: AuthCoreDeps): Promise<string | null> {
  const tokens = deps.getTokens();
  if (!tokens) return null;

  const now = deps.now();
  const margin = deps.marginSeconds ?? REFRESH_MARGIN_SECONDS;
  if (tokens.expires_at - now > margin) {
    return tokens.access_token;
  }

  const creds = deps.getEffectiveClientCredentials();
  if (!creds) return null;

  const url = deps.tokenUrl ?? RADIOPAEDIA_TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
  });

  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] token refresh failed (network)');
    return null;
  }

  if (!resp.ok) {
    if (resp.status >= 400 && resp.status < 500) {
      deps.clearTokens();
    }
    // eslint-disable-next-line no-console
    console.warn(`[radiopaedia] token refresh failed (${resp.status})`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] token refresh failed (bad json)');
    return null;
  }

  const parsed = parseTokenResponseCore(payload, deps.now());
  if (!parsed) {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] token refresh failed (bad payload)');
    return null;
  }

  deps.setTokens(parsed);
  return parsed.access_token;
}

// ---------- OOB authorization-code exchange ----------
//
// The OOB flow in `radiopaedia-oauth-oob.ts` is split across two user
// actions (open browser → paste code back), so it exports two separate
// functions. The paste-back half's logic lives here as the pure
// `exchangeAuthorizationCodeCore` so tests can drive it without Electron.

export type ExchangeCoreResult = 'ok' | 'error';

export interface ExchangeCoreDeps {
  fetch: typeof fetch;
  now: () => number; // epoch seconds
  setTokens: (t: RadiopaediaTokensCore) => void;
  getEffectiveClientCredentials: () =>
    | { client_id: string; client_secret: string }
    | null;
  redirectUri: string;
  tokenUrl: string;
}

export async function exchangeAuthorizationCodeCore(
  code: string,
  deps: ExchangeCoreDeps,
): Promise<ExchangeCoreResult> {
  const creds = deps.getEffectiveClientCredentials();
  if (!creds) {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (no-client-credentials)');
    return 'error';
  }
  if (typeof code !== 'string' || code === '') {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (empty-code)');
    return 'error';
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: deps.redirectUri,
  });

  let resp: Response;
  try {
    resp = await deps.fetch(deps.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (network)');
    return 'error';
  }

  if (!resp.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[radiopaedia] authorization exchange failed (${resp.status})`);
    return 'error';
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (bad-json)');
    return 'error';
  }

  const tokens = parseTokenResponseCore(payload, deps.now());
  if (!tokens) {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (bad-payload)');
    return 'error';
  }

  try {
    deps.setTokens(tokens);
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[radiopaedia] authorization exchange failed (persist)');
    return 'error';
  }
  return 'ok';
}

/**
 * Pure /oauth/authorize URL builder. Takes the authorize URL as an
 * argument so tests don't have to monkey-patch the constant.
 * No `scope`, no PKCE — Radiopaedia supports neither.
 */
export function buildAuthorizeUrlCore(
  clientId: string,
  redirectUri: string,
  authorizeUrl: string,
): string {
  const u = new URL(authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  return u.toString();
}
