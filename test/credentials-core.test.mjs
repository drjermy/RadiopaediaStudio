// Unit tests for src/main/credentials-core.ts.
//
// The shape validators guard what we read off disk in credentials.ts.
// They are intentionally split into a no-electron module so this test
// can load them without needing an Electron environment.
//
// Why this matters: a corrupted persistence file (manually edited,
// half-written from a crash, schema-drifted from an older app version)
// would otherwise reach `setRadiopaediaTokens` / `setRadiopaediaClientOverride`
// callers as a malformed object and fail on first use. The validators
// are the boundary that turns those into a clean "no tokens" / "no
// override" signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../dist/main/credentials-core.js');
const { isRadiopaediaTokens, isRadiopaediaClientOverride } = mod;

// --- isRadiopaediaTokens ---

const validTokens = () => ({
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 1700000000,
  token_type: 'Bearer',
});

test('isRadiopaediaTokens: accepts a fully-populated valid record', () => {
  assert.equal(isRadiopaediaTokens(validTokens()), true);
});

test('isRadiopaediaTokens: rejects null / undefined / non-object inputs', () => {
  assert.equal(isRadiopaediaTokens(null), false);
  assert.equal(isRadiopaediaTokens(undefined), false);
  assert.equal(isRadiopaediaTokens('a string'), false);
  assert.equal(isRadiopaediaTokens(42), false);
  assert.equal(isRadiopaediaTokens([]), false);
});

test('isRadiopaediaTokens: rejects records missing any required field', () => {
  for (const field of ['access_token', 'refresh_token', 'expires_at', 'token_type']) {
    const t = validTokens();
    delete t[field];
    assert.equal(isRadiopaediaTokens(t), false, `missing ${field}`);
  }
});

test('isRadiopaediaTokens: rejects wrong-typed fields', () => {
  // expires_at must be a number — string-on-disk (from a hand-edit or
  // older schema) would otherwise pass through.
  assert.equal(isRadiopaediaTokens({ ...validTokens(), expires_at: '1700000000' }), false);
  assert.equal(isRadiopaediaTokens({ ...validTokens(), access_token: 42 }), false);
  assert.equal(isRadiopaediaTokens({ ...validTokens(), refresh_token: null }), false);
});

test('isRadiopaediaTokens: rejects non-Bearer token_type', () => {
  // The OAuth spec allows other token_type values but Radiopaedia only
  // returns Bearer; pinning the literal here means an upstream change
  // surfaces as a test failure rather than a runtime header bug.
  assert.equal(isRadiopaediaTokens({ ...validTokens(), token_type: 'bearer' }), false);
  assert.equal(isRadiopaediaTokens({ ...validTokens(), token_type: 'Mac' }), false);
  assert.equal(isRadiopaediaTokens({ ...validTokens(), token_type: '' }), false);
});

test('isRadiopaediaTokens: extra fields are tolerated', () => {
  // Forward-compatibility: if Radiopaedia adds a field we don't model,
  // we should still accept the record so persistence keeps working.
  const extra = { ...validTokens(), scope: 'read write', foo: 'bar' };
  assert.equal(isRadiopaediaTokens(extra), true);
});

// --- isRadiopaediaClientOverride ---

const validOverride = () => ({ client_id: 'id', client_secret: 'secret' });

test('isRadiopaediaClientOverride: accepts populated record', () => {
  assert.equal(isRadiopaediaClientOverride(validOverride()), true);
});

test('isRadiopaediaClientOverride: empty strings still pass the shape check', () => {
  // The "treat empty strings as not configured" rule lives in
  // credentials.getRadiopaediaClientOverride, not here. The shape guard
  // only checks types; getter logic decides semantics.
  assert.equal(isRadiopaediaClientOverride({ client_id: '', client_secret: '' }), true);
});

test('isRadiopaediaClientOverride: rejects null / non-object inputs', () => {
  assert.equal(isRadiopaediaClientOverride(null), false);
  assert.equal(isRadiopaediaClientOverride(undefined), false);
  assert.equal(isRadiopaediaClientOverride('id'), false);
  assert.equal(isRadiopaediaClientOverride([]), false);
});

test('isRadiopaediaClientOverride: rejects missing fields and wrong types', () => {
  assert.equal(isRadiopaediaClientOverride({ client_id: 'id' }), false);
  assert.equal(isRadiopaediaClientOverride({ client_secret: 'secret' }), false);
  assert.equal(isRadiopaediaClientOverride({ client_id: 42, client_secret: 'secret' }), false);
  assert.equal(isRadiopaediaClientOverride({ client_id: 'id', client_secret: null }), false);
});
