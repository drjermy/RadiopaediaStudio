// Build-time Radiopaedia OAuth client credentials.
//
// This file is the committed TEMPLATE. The real, gitignored
// `radiopaedia-config.ts` is produced one of two ways:
//
//   1. For CI / packaging: `scripts/write-radiopaedia-config.mjs` reads
//      `RADIOPAEDIA_CLIENT_ID` / `RADIOPAEDIA_CLIENT_SECRET` from the
//      environment and writes this file with those literals baked in.
//   2. For local dev: copy this file to `radiopaedia-config.ts` by hand
//      and paste in your own values (or leave them empty and rely on a
//      runtime override via `setRadiopaediaClientOverride`).
//
// Empty strings are valid placeholders — `getEffectiveClientCredentials`
// in `radiopaedia-auth.ts` treats them as "not configured" and falls
// back to the user-supplied override.
//
// The redirect URI is `urn:ietf:wg:oauth:2.0:oob` (out-of-band). We do
// NOT use a `http://127.0.0.1:<port>/callback` loopback: Radiopaedia's
// OAuth app-registration form rejects non-HTTPS redirect URIs with the
// message "Must be an https/ssl uri. Use urn:ietf:wg:oauth:2.0:oob for
// local tests", so OOB is the only viable redirect for a desktop app.
//
// With OOB the flow is:
//   1. We open the system browser at /oauth/authorize?...&redirect_uri=urn:...
//   2. The user authorises; Radiopaedia shows the authorization code on
//      its own confirmation page.
//   3. The user pastes the code into our Settings panel; we POST it to
//      /oauth/token. See `radiopaedia-oauth-oob.ts`.

export const RADIOPAEDIA_CLIENT_ID = '';
export const RADIOPAEDIA_CLIENT_SECRET = '';
export const RADIOPAEDIA_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

// Radiopaedia site base URL. Dev/test builds point at the staging site;
// production builds use `https://radiopaedia.org`. All authorize/token/API
// URLs are derived from this base in `radiopaedia-auth.ts`. Override via
// the `RADIOPAEDIA_API_BASE` env var at build time — no trailing slash.
export const RADIOPAEDIA_API_BASE = 'https://radiopaedia.org';
