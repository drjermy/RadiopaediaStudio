// Desktop OAuth authorization-code flow using the OOB (out-of-band)
// redirect `urn:ietf:wg:oauth:2.0:oob`.
//
// Why OOB instead of a 127.0.0.1 loopback (RFC 8252 §7.3)?
// Radiopaedia's OAuth app-registration form rejects non-HTTPS redirect
// URIs with the message "Must be an https/ssl uri. Use
// urn:ietf:wg:oauth:2.0:oob for local tests". A desktop app can't
// terminate HTTPS on an ephemeral local port without a cert, so OOB is
// the only viable redirect for us.
//
// The flow splits across two user actions, so this module exports two
// functions instead of one orchestrated promise:
//
//   1. `openAuthorizationPage()` — opens the system browser at
//      /oauth/authorize?...&redirect_uri=urn:ietf:wg:oauth:2.0:oob.
//      The user authorises; Radiopaedia displays the authorization code
//      on its own confirmation page.
//   2. The user copies the code and pastes it into our Settings input.
//   3. `exchangeAuthorizationCode(code)` — POSTs the code to /oauth/token
//      and persists the returned tokens.
//
// No HTTP server, no port handling, no timeout — the user controls how
// long the whole thing takes.
//
// PKCE is intentionally NOT used: per Andy's reference implementation
// (RadiopaediaConnect, C#), the Radiopaedia OAuth endpoints don't
// support PKCE and the client_secret is required on every token
// exchange.
//
// The `scope` query param is omitted — Radiopaedia's spec doesn't
// define scopes.
//
// All non-trivial logic lives in the pure `*Core` helpers in
// `radiopaedia-auth-core.ts` so tests can drive them without Electron.
// This module is just the thin Electron-aware wiring.
//
// Never log the code, the tokens, or the client_secret.

import { shell } from 'electron';
import { setRadiopaediaTokens } from './credentials';
import {
  RADIOPAEDIA_AUTHORIZE_URL,
  RADIOPAEDIA_TOKEN_URL,
  getEffectiveClientCredentials,
} from './radiopaedia-auth';
import {
  buildAuthorizeUrlCore,
  exchangeAuthorizationCodeCore,
  type ExchangeCoreResult,
} from './radiopaedia-auth-core';
import { RADIOPAEDIA_REDIRECT_URI } from './radiopaedia-config';

export type AuthExchangeResult = ExchangeCoreResult;

/**
 * Open the system browser at the Radiopaedia authorize URL. Returns
 * when the browser launch has been dispatched — not when the user has
 * authorised. The authorization code lands on Radiopaedia's OOB
 * confirmation page; the user pastes it back into our Settings UI and
 * we exchange it via `exchangeAuthorizationCode`.
 *
 * Silent on success. Throws on misconfiguration (no client credentials)
 * or if the OS refuses to open a browser — callers can surface those as
 * a user-visible error.
 */
export async function openAuthorizationPage(): Promise<void> {
  const creds = getEffectiveClientCredentials();
  if (!creds) {
    throw new Error(
      '[radiopaedia] cannot start auth flow: no client credentials ' +
        '(neither baked at build time nor supplied as an override)',
    );
  }
  const authorizeUrl = buildAuthorizeUrlCore(
    creds.client_id,
    RADIOPAEDIA_REDIRECT_URI,
    RADIOPAEDIA_AUTHORIZE_URL,
  );
  await shell.openExternal(authorizeUrl);
}

/**
 * Exchange an authorization code (pasted by the user after authorising
 * on radiopaedia.org) for the access/refresh token trio, and persist it
 * via `setRadiopaediaTokens`.
 *
 * Returns 'ok' on success, 'error' on any failure. See the core in
 * `radiopaedia-auth-core.ts` for the logging + branching contract.
 */
export async function exchangeAuthorizationCode(
  code: string,
): Promise<AuthExchangeResult> {
  return exchangeAuthorizationCodeCore(code, {
    fetch: (...args) => fetch(...args),
    now: () => Math.floor(Date.now() / 1000),
    setTokens: (t) => setRadiopaediaTokens(t),
    getEffectiveClientCredentials,
    redirectUri: RADIOPAEDIA_REDIRECT_URI,
    tokenUrl: RADIOPAEDIA_TOKEN_URL,
  });
}
