import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import * as path from 'path';

// Encrypted-at-rest credentials file. Backed by Electron's safeStorage, which
// uses the macOS Keychain on darwin and OS-level secret storage on other
// platforms. We deliberately refuse to fall back to plaintext: if the platform
// can't encrypt, we simply disable token persistence.

const FILE_NAME = 'credentials.enc';

let warnedUnavailable = false;

function credentialsFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function ensureEncryptionAvailable(): boolean {
  if (safeStorage.isEncryptionAvailable()) return true;
  if (!warnedUnavailable) {
    // eslint-disable-next-line no-console
    console.warn('[credentials] safeStorage not available — token persistence disabled');
    warnedUnavailable = true;
  }
  return false;
}

export function getRadiopaediaToken(): string | null {
  if (!ensureEncryptionAvailable()) return null;
  const file = credentialsFilePath();
  if (!existsSync(file)) return null;
  try {
    const buf = readFileSync(file);
    if (buf.length === 0) return null;
    return safeStorage.decryptString(buf);
  } catch (err) {
    // Decrypt failure (e.g. keychain rotated, corrupt file). Don't log the
    // token or raw error payload; just surface that we couldn't read it.
    // eslint-disable-next-line no-console
    console.warn('[credentials] failed to decrypt token file');
    return null;
  }
}

export function setRadiopaediaToken(token: string): void {
  if (typeof token !== 'string') {
    throw new Error('[credentials] token must be a string');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('[credentials] safeStorage not available — cannot persist token');
  }
  const encrypted = safeStorage.encryptString(token);
  writeFileSync(credentialsFilePath(), encrypted, { mode: 0o600 });
}

export function clearRadiopaediaToken(): void {
  const file = credentialsFilePath();
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // Best-effort: if removal fails, overwrite with empty buffer so a
      // subsequent get() returns null.
      try {
        writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
      } catch {
        /* swallow */
      }
    }
  }
}
