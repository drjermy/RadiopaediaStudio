import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as path from 'path';

// Encrypted-at-rest credentials. Backed by Electron's safeStorage, which uses
// the macOS Keychain on darwin and OS-level secret storage on other platforms.
// We deliberately refuse to fall back to plaintext: if the platform can't
// encrypt, we simply disable persistence.
//
// Two independent records live here:
//
//   1. RadiopaediaTokens         — OAuth access/refresh trio returned by
//                                  /oauth/token. File: `radiopaedia-tokens.enc`.
//   2. RadiopaediaClientOverride — optional user-supplied override of the
//                                  build-time client_id / client_secret for
//                                  institutional users. File:
//                                  `radiopaedia-client-override.enc`.
//
// No migration is performed from the previous single-string schema — the
// app hadn't shipped, nothing to migrate.

export interface RadiopaediaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds; computed as now + expires_in at save time
  token_type: 'Bearer';
}

export interface RadiopaediaClientOverride {
  client_id: string;
  client_secret: string;
}

const TOKENS_FILE = 'radiopaedia-tokens.enc';
const OVERRIDE_FILE = 'radiopaedia-client-override.enc';

let warnedUnavailable = false;

function tokensPath(): string {
  return path.join(app.getPath('userData'), TOKENS_FILE);
}

function overridePath(): string {
  return path.join(app.getPath('userData'), OVERRIDE_FILE);
}

function ensureEncryptionAvailable(): boolean {
  if (safeStorage.isEncryptionAvailable()) return true;
  if (!warnedUnavailable) {
    // eslint-disable-next-line no-console
    console.warn('[credentials] safeStorage not available — persistence disabled');
    warnedUnavailable = true;
  }
  return false;
}

function readEncryptedJSON<T>(file: string, label: string): T | null {
  if (!ensureEncryptionAvailable()) return null;
  if (!existsSync(file)) return null;
  try {
    const buf = readFileSync(file);
    if (buf.length === 0) return null;
    const plain = safeStorage.decryptString(buf);
    return JSON.parse(plain) as T;
  } catch {
    // Don't log the ciphertext or raw error — just surface a read failure.
    // eslint-disable-next-line no-console
    console.warn(`[credentials] failed to read ${label}`);
    return null;
  }
}

function writeEncryptedJSON(file: string, value: unknown, label: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`[credentials] safeStorage not available — cannot persist ${label}`);
  }
  const plain = JSON.stringify(value);
  const encrypted = safeStorage.encryptString(plain);
  writeFileSync(file, encrypted, { mode: 0o600 });
}

function removeFile(file: string): void {
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    try {
      writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    } catch {
      /* swallow */
    }
  }
}

function isRadiopaediaTokens(v: unknown): v is RadiopaediaTokens {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.access_token === 'string' &&
    typeof o.refresh_token === 'string' &&
    typeof o.expires_at === 'number' &&
    o.token_type === 'Bearer'
  );
}

function isRadiopaediaClientOverride(v: unknown): v is RadiopaediaClientOverride {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.client_id === 'string' && typeof o.client_secret === 'string';
}

// --- Tokens ---

export function getRadiopaediaTokens(): RadiopaediaTokens | null {
  const raw = readEncryptedJSON<unknown>(tokensPath(), 'tokens');
  if (!raw) return null;
  if (!isRadiopaediaTokens(raw)) {
    // eslint-disable-next-line no-console
    console.warn('[credentials] stored tokens failed shape check — ignoring');
    return null;
  }
  return raw;
}

export function setRadiopaediaTokens(tokens: RadiopaediaTokens): void {
  if (!isRadiopaediaTokens(tokens)) {
    throw new Error('[credentials] setRadiopaediaTokens: invalid shape');
  }
  writeEncryptedJSON(tokensPath(), tokens, 'tokens');
}

export function clearRadiopaediaTokens(): void {
  removeFile(tokensPath());
}

// --- Client override ---

export function getRadiopaediaClientOverride(): RadiopaediaClientOverride | null {
  const raw = readEncryptedJSON<unknown>(overridePath(), 'client override');
  if (!raw) return null;
  if (!isRadiopaediaClientOverride(raw)) {
    // eslint-disable-next-line no-console
    console.warn('[credentials] stored client override failed shape check — ignoring');
    return null;
  }
  // Treat fully empty strings as "not configured" so callers can rely on
  // `null` meaning "no override in effect".
  if (raw.client_id === '' && raw.client_secret === '') return null;
  return raw;
}

export function setRadiopaediaClientOverride(override: RadiopaediaClientOverride): void {
  if (!isRadiopaediaClientOverride(override)) {
    throw new Error('[credentials] setRadiopaediaClientOverride: invalid shape');
  }
  writeEncryptedJSON(overridePath(), override, 'client override');
}

export function clearRadiopaediaClientOverride(): void {
  removeFile(overridePath());
}
