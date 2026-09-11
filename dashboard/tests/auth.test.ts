import { describe, expect, it } from 'vitest';
import {
  credentialsConfigured,
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/lib/server/auth';

const SECRET = 'a-long-random-session-secret-for-tests-only';

describe('password verification', () => {
  const stored = hashPassword('correct horse battery staple');

  it('produces the documented scrypt$salt$hash shape', () => {
    const [scheme, salt, hash] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('accepts the right password', () => {
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
    expect(verifyPassword('CORRECT HORSE BATTERY STAPLE', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', () => {
    expect(hashPassword('correct horse battery staple')).not.toBe(stored);
  });

  it('rejects rather than throws on a malformed or empty stored value', () => {
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'plaintext')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$notHex$alsoNotHex')).toBe(false);
    expect(verifyPassword('anything', 'bcrypt$aa$bb')).toBe(false);
  });
});

describe('fail-closed credential gate', () => {
  it('is not configured when either half is missing', () => {
    expect(credentialsConfigured('', SECRET)).toBe(false);
    expect(credentialsConfigured('scrypt$aa$bb', '')).toBe(false);
    expect(credentialsConfigured('   ', SECRET)).toBe(false);
    expect(credentialsConfigured('scrypt$aa$bb', SECRET)).toBe(true);
  });
});

describe('session cookies', () => {
  const now = Date.UTC(2026, 7, 15, 12, 0, 0);
  const expiresAt = now + 12 * 60 * 60 * 1000;

  it('round-trips a signed session', () => {
    const cookie = signSession({ user: 'owner', expiresAt }, SECRET);
    const session = verifySession(cookie, SECRET, now);
    expect(session).toEqual({ user: 'owner', expiresAt });
  });

  it('rejects a cookie whose payload was edited', () => {
    const cookie = signSession({ user: 'owner', expiresAt }, SECRET);
    const [, signature] = cookie.split('.') as [string, string];
    const forged = `${Buffer.from(`intruder|${expiresAt}`, 'utf8').toString('base64url')}.${signature}`;
    expect(verifySession(forged, SECRET, now)).toBeNull();
  });

  it('rejects a cookie whose signature was edited', () => {
    const cookie = signSession({ user: 'owner', expiresAt }, SECRET);
    const dot = cookie.lastIndexOf('.');
    const tampered = `${cookie.slice(0, dot)}.${'0'.repeat(cookie.length - dot - 1)}`;
    expect(verifySession(tampered, SECRET, now)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSession({ user: 'owner', expiresAt }, 'some-other-secret');
    expect(verifySession(cookie, SECRET, now)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const cookie = signSession({ user: 'owner', expiresAt }, SECRET);
    expect(verifySession(cookie, SECRET, expiresAt + 1)).toBeNull();
  });

  it('rejects junk, empties and a missing secret', () => {
    expect(verifySession(undefined, SECRET, now)).toBeNull();
    expect(verifySession('', SECRET, now)).toBeNull();
    expect(verifySession('not-a-cookie', SECRET, now)).toBeNull();
    expect(verifySession(signSession({ user: 'owner', expiresAt }, SECRET), '', now)).toBeNull();
  });
});
