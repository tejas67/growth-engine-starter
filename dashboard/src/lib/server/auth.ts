/**
 * Dashboard credentials and sessions.
 *
 * Everything here is PURE over its arguments — no config reads, no database, no
 * clock of its own. That is what lets the password check, the cookie signature and
 * the tamper rejection be unit-tested directly, with no server running.
 *
 * Two separate secrets, doing two separate jobs:
 *  - the password hash proves WHO is logging in (scrypt, deliberately slow),
 *  - the session secret proves a cookie was issued BY US (HMAC-SHA256, fast).
 *
 * Both comparisons are constant-time. A timing difference on a login form is a real
 * leak, and it costs nothing to close.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** How long a login lasts before the founder has to sign in again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'growth_session';

/**
 * Produce a stored credential in the form `scrypt$<saltHex>$<hashHex>`.
 * Used only by scripts/hash-password.ts — the running app never hashes, only verifies.
 */
export function hashPassword(password: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password, s, SCRYPT_KEYLEN);
  return `scrypt$${s.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Constant-time check of a submitted password against a stored `scrypt$salt$hash`.
 * A malformed or empty stored value returns false — never true, never a throw.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [scheme, saltHex, hashHex] = parts as [string, string, string];
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------- sessions -- */

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromBase64url(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export interface Session {
  user: string;
  /** Epoch milliseconds at which this cookie stops being accepted. */
  expiresAt: number;
}

/**
 * Sign `user|expiry` and return the cookie value. The cookie carries no secret of
 * its own: it is only ever trusted because the signature verifies.
 */
export function signSession(session: Session, secret: string): string {
  if (!secret) throw new Error('cannot sign a session without a session secret');
  const claim = `${session.user}|${session.expiresAt}`;
  return `${base64url(claim)}.${sign(claim, secret)}`;
}

/**
 * Verify a cookie value. Returns null for anything that is not a currently-valid,
 * correctly-signed session: wrong signature, edited payload, missing secret, expired.
 */
export function verifySession(value: string | undefined | null, secret: string, now: number): Session | null {
  if (!value || !secret) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = value.slice(0, dot);
  const providedSig = value.slice(dot + 1);
  const claim = fromBase64url(encoded);
  if (claim === null) return null;

  const expectedSig = sign(claim, secret);
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const sep = claim.lastIndexOf('|');
  if (sep <= 0) return null;
  const user = claim.slice(0, sep);
  const expiresAt = Number(claim.slice(sep + 1));
  if (!user || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return null;

  return { user, expiresAt };
}

/**
 * Fail-closed gate. With no password hash and no session secret configured the
 * dashboard must refuse to serve anything, rather than quietly running open.
 */
export function credentialsConfigured(passwordHash: string, sessionSecret: string): boolean {
  return passwordHash.trim().length > 0 && sessionSecret.trim().length > 0;
}

export const NOT_CONFIGURED_MESSAGE =
  'The dashboard credentials are not configured. Set GROWTH_DASHBOARD_PASSWORD_HASH and ' +
  'GROWTH_SESSION_SECRET in the environment, then restart. Until then nobody can sign in — ' +
  'this is deliberate, so a missing setting can never leave the dashboard open.';
