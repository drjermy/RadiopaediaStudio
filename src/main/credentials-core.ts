// Pure shape validators for the credential records persisted by
// `src/main/credentials.ts`. Lives in its own module so unit tests can
// import without dragging in `electron` (and therefore `app` /
// `safeStorage`, which need an Electron environment to run).
//
// Keep the schema definitions here in lockstep with credentials.ts —
// any field the persistence layer touches has to be reflected in the
// guard, otherwise a corrupt-on-disk record could slip through and
// surface as a runtime error mid-upload.

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

export function isRadiopaediaTokens(v: unknown): v is RadiopaediaTokens {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.access_token === 'string' &&
    typeof o.refresh_token === 'string' &&
    typeof o.expires_at === 'number' &&
    o.token_type === 'Bearer'
  );
}

export function isRadiopaediaClientOverride(
  v: unknown,
): v is RadiopaediaClientOverride {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.client_id === 'string' && typeof o.client_secret === 'string';
}
