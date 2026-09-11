/**
 * The gate.
 *
 * Two rules, both fail-closed:
 *  1. If the password hash or the session secret is missing, no authenticated route
 *     is served at all. A missing setting must never read as "no password needed".
 *  2. Every route except /login and /logout requires a valid signed session.
 */
import { redirect, type Handle } from '@sveltejs/kit';
import { config } from '$config';
import { credentialsConfigured, SESSION_COOKIE, verifySession } from '$lib/server/auth';

// /healthz is public because a deploy has to be able to ask "are you working?" before
// anybody has logged in. It returns a boolean and nothing else.
const PUBLIC_PATHS = new Set(['/login', '/logout', '/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
  const configured = credentialsConfigured(
    config.dashboard.passwordHash,
    config.dashboard.sessionSecret,
  );
  event.locals.credentialsConfigured = configured;

  const session = configured
    ? verifySession(
        event.cookies.get(SESSION_COOKIE),
        config.dashboard.sessionSecret,
        Date.now(),
      )
    : null;
  event.locals.user = session?.user ?? null;

  const path = event.url.pathname;
  const isPublic = PUBLIC_PATHS.has(path);

  if (!isPublic && (!configured || !event.locals.user)) {
    // The login page explains WHY when credentials are not configured.
    throw redirect(303, '/login');
  }

  return resolve(event);
};
