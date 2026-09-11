/**
 * Health check — the one unauthenticated route in the dashboard.
 *
 * It answers the question a deploy actually needs answered: "is this thing able to do
 * its job right now?" A dashboard that boots but cannot reach Postgres is not healthy,
 * so a database round trip is part of the check and a failure returns 503. The
 * alternative — a 200 that only proves Node started — would turn the deploy gate into
 * a formality.
 *
 * It deliberately reveals nothing: no version, no counts, no error text, because this
 * route is reachable from the open internet.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$db';

export const GET: RequestHandler = async () => {
  try {
    await db().query('SELECT 1');
    return json({ ok: true, database: 'ok' });
  } catch {
    return json({ ok: false, database: 'unreachable' }, { status: 503 });
  }
};
