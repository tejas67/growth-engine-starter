/**
 * Sign-in.
 *
 * One named credential, because the audit trail's "who" has to mean something. Every
 * attempt — successful or not — lands in `login_attempt`, and the rate limiter reads
 * that same table, so the record and the enforcement can never drift apart.
 */
import { fail, redirect, type Actions, type ServerLoad } from '@sveltejs/kit';
import { config } from '$config';
import {
  credentialsConfigured,
  NOT_CONFIGURED_MESSAGE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
  verifyPassword,
} from '$lib/server/auth';
import { clientIp, evaluateRateLimit } from '$lib/server/ratelimit';
import { recentLoginAttempts, recordLoginAttempt } from '$lib/server/queries';

export const load: ServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(303, '/');
  return {
    configured: locals.credentialsConfigured,
    notConfiguredMessage: NOT_CONFIGURED_MESSAGE,
    user: config.dashboard.user,
  };
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress, setHeaders, url }) => {
    const configured = credentialsConfigured(
      config.dashboard.passwordHash,
      config.dashboard.sessionSecret,
    );
    if (!configured) {
      // Fail closed: no hash, no session secret, no way in.
      return fail(503, { message: NOT_CONFIGURED_MESSAGE });
    }

    const form = await request.formData();
    const user = String(form.get('user') ?? '').trim();
    const password = String(form.get('password') ?? '');

    const ip = clientIp(request.headers.get('x-forwarded-for'), getClientAddress());
    const now = new Date();
    const windowStart = new Date(now.getTime() - config.dashboard.loginWindowMinutes * 60 * 1000);

    const attempts = await recentLoginAttempts(ip, windowStart);
    const limit = evaluateRateLimit(
      attempts,
      now,
      config.dashboard.loginMaxAttempts,
      config.dashboard.loginWindowMinutes,
    );

    if (limit.blocked) {
      // The refusal is itself an attempt, and it is recorded like any other.
      await recordLoginAttempt(user || null, ip, false);
      setHeaders({ 'retry-after': String(limit.retryAfterSeconds) });
      return fail(429, { message: limit.message });
    }

    const ok = user === config.dashboard.user && verifyPassword(password, config.dashboard.passwordHash);
    await recordLoginAttempt(user || null, ip, ok);

    if (!ok) {
      const left = Math.max(0, limit.remaining - 1);
      return fail(401, {
        message:
          left > 0
            ? `That user name and password did not match. ${left} more attempt(s) before this address is paused.`
            : 'That user name and password did not match. This address is now paused for a while.',
      });
    }

    const expiresAt = now.getTime() + SESSION_TTL_MS;
    cookies.set(SESSION_COOKIE, signSession({ user, expiresAt }, config.dashboard.sessionSecret), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      expires: new Date(expiresAt),
    });

    throw redirect(303, '/');
  },
};
