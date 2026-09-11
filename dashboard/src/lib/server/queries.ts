/**
 * Every line of SQL the dashboard owns lives here.
 *
 * The engine's repository layer (src/repo) already owns the writes that change
 * meaning — approvals, audit rows, events, suppression, lane state — and this file
 * never duplicates one of those. What it holds is the READ shapes the three views
 * need (a touch joined to its prospect, replies joined to their thread, the flat
 * fact tables the metrics module folds) plus the login-attempt ledger.
 */
import type { PoolClient } from 'pg';
import { db } from '$db';
import type { EventFact, TouchFact } from '$core/metrics/funnels.js';
import type { TouchState, TouchStatus } from '$core/approval/state.js';
import type { AliasKind } from '$core/lib/identity.js';
import type { ProspectCard } from '$lib/types';

export type { ProspectCard };

type Q = Pick<PoolClient, 'query'>;

function q(client?: Q): Q {
  return client ?? db();
}

/* -------------------------------------------------------------- prospects -- */

/** The prospect facts an approval card shows, plus their most recent ICP score. */
export async function prospectsByIds(
  ids: number[],
  client?: Q,
): Promise<Map<number, ProspectCard>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q(client).query<ProspectCard>(
    `SELECT p.id, p.full_name, p.headline, p.company_name, p.company_domain,
            p.company_verified, p.linkedin_url, p.email, p.is_gov,
            a.score, a.persona
       FROM prospect p
       LEFT JOIN LATERAL (
         SELECT score, persona FROM icp_assessment
          WHERE prospect_id = p.id ORDER BY created_at DESC LIMIT 1
       ) a ON TRUE
      WHERE p.id = ANY($1)`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export interface SignalRow {
  prospect_id: number;
  engagement_type: string;
  comment_text: string | null;
  detected_at: Date;
  post_url: string | null;
  author_name: string | null;
  author_headline: string | null;
  content_text: string | null;
  posted_at: Date | null;
}

/**
 * Every engagement behind a set of prospects, newest first, with the post it landed
 * on. This is the founder's "why is this person here" — the source of the signal.
 */
export async function signalsByProspectIds(
  ids: number[],
  client?: Q,
): Promise<Map<number, SignalRow[]>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q(client).query<SignalRow>(
    `SELECT e.prospect_id, e.engagement_type, e.comment_text, e.detected_at,
            po.post_url, po.author_name, po.author_headline,
            LEFT(po.content_text, 400) AS content_text, po.posted_at
       FROM engagement e
       JOIN post po ON po.id = e.post_id
      WHERE e.prospect_id = ANY($1)
      ORDER BY e.prospect_id, e.detected_at DESC`,
    [ids],
  );
  const out = new Map<number, SignalRow[]>();
  for (const r of rows) {
    const list = out.get(r.prospect_id) ?? [];
    if (list.length < 5) list.push(r);
    out.set(r.prospect_id, list);
  }
  return out;
}

export interface PausedProspect {
  id: number;
  full_name: string | null;
  company_name: string | null;
  sequence_paused_at: Date;
  sequence_pause_reason: string | null;
}

export async function listPausedProspects(limit = 100, client?: Q): Promise<PausedProspect[]> {
  const { rows } = await q(client).query<PausedProspect>(
    `SELECT id, full_name, company_name, sequence_paused_at, sequence_pause_reason
       FROM prospect
      WHERE sequence_paused_at IS NOT NULL
      ORDER BY sequence_paused_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function aliasesForProspect(
  prospectId: number,
  client?: Q,
): Promise<Array<{ kind: AliasKind; value: string }>> {
  const { rows } = await q(client).query<{ alias_kind: AliasKind; alias_value: string }>(
    `SELECT alias_kind, alias_value FROM prospect_alias WHERE prospect_id = $1`,
    [prospectId],
  );
  return rows.map((r) => ({ kind: r.alias_kind, value: r.alias_value }));
}

/* ---------------------------------------------------------------- touches -- */

interface TouchStateRow {
  id: number;
  status: TouchStatus;
  subject: string | null;
  body: string;
  connect_note: string | null;
  template_version: string;
  founder_edited: boolean;
  content_hash: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  skipped_at: Date | null;
}

/**
 * Load a touch as the pure transition functions want to see it, holding the row for
 * the rest of the transaction. The lock is what makes a double-tap from a phone
 * (two requests, milliseconds apart) resolve to one approval instead of two.
 */
export async function lockTouchForUpdate(touchId: number, client: Q): Promise<TouchState | null> {
  const { rows } = await client.query<TouchStateRow>(
    `SELECT id, status, subject, body, connect_note, template_version, founder_edited,
            content_hash, approved_at, approved_by, skipped_at
       FROM touch WHERE id = $1 FOR UPDATE`,
    [touchId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    subject: row.subject,
    body: row.body,
    connectNote: row.connect_note,
    templateVersion: row.template_version,
    founderEdited: row.founder_edited,
    contentHash: row.content_hash,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    skippedAt: row.skipped_at,
  };
}

/* ----------------------------------------------------------------- events -- */

export interface ReplyRow {
  id: string;
  kind: string;
  channel: string | null;
  occurred_at: Date;
  payload: Record<string, unknown> | null;
  touch_id: number | null;
  prospect_id: number | null;
  full_name: string | null;
  headline: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  email: string | null;
  sequence_paused_at: Date | null;
  sequence_pause_reason: string | null;
  gmail_thread_url: string | null;
  email_message_id: string | null;
  provider_thread_id: string | null;
  touch_channel: string | null;
  /** The founder's own classification of this reply, when one has been recorded. */
  founder_verdict: string | null;
}

const REPLY_KINDS = [
  'reply',
  'positive_reply',
  'negative_reply',
  'neutral_reply',
  'unmatched_reply',
];

export async function listReplies(
  limit = 200,
  client?: Q,
  selection?: { prospectId?: number; eventId?: string },
): Promise<ReplyRow[]> {
  const { rows } = await q(client).query<ReplyRow>(
    `SELECT e.id::TEXT AS id, e.kind, e.channel, e.occurred_at, e.payload,
            e.touch_id, e.prospect_id,
            p.full_name, p.headline, p.company_name, p.linkedin_url, p.email,
            p.sequence_paused_at, p.sequence_pause_reason,
            t.gmail_thread_url, t.email_message_id, t.provider_thread_id,
            t.channel AS touch_channel,
            v.kind AS founder_verdict
       FROM event e
       LEFT JOIN prospect p ON p.id = e.prospect_id
       LEFT JOIN touch t ON t.id = e.touch_id
       LEFT JOIN LATERAL (
         SELECT kind FROM event fv
          WHERE fv.source = 'dashboard'
            AND fv.event_key LIKE 'dashboard:reclassify:' || e.id::TEXT || ':%'
          ORDER BY fv.ingested_at DESC LIMIT 1
       ) v ON TRUE
      WHERE e.kind = ANY($1)
        AND e.source <> 'dashboard'
        AND ($3::int IS NULL OR (e.prospect_id = $3 AND e.kind <> 'unmatched_reply'))
        AND ($4::bigint IS NULL OR e.id = $4)
      ORDER BY e.occurred_at DESC
      LIMIT $2`,
    [REPLY_KINDS, limit, selection?.prospectId ?? null, selection?.eventId ?? null],
  );
  return rows;
}

/**
 * Clear an earlier founder verdict on the same reply before recording a new one.
 * The keys are deterministic, so this is an exact-key delete, not a scan — and it
 * only ever removes rows the dashboard itself wrote. Ingested history is untouched.
 */
export async function clearFounderVerdicts(
  sourceEventId: string,
  keepKind: string,
  client: Q,
): Promise<void> {
  const keys = ['positive_reply', 'negative_reply', 'neutral_reply']
    .filter((k) => k !== keepKind)
    .map((k) => `dashboard:reclassify:${sourceEventId}:${k}`);
  await client.query(`DELETE FROM event WHERE event_key = ANY($1)`, [keys]);
}

export async function replyById(eventId: string, client?: Q): Promise<ReplyRow | null> {
  const { rows } = await q(client).query<ReplyRow>(
    `SELECT e.id::TEXT AS id, e.kind, e.channel, e.occurred_at, e.payload,
            e.touch_id, e.prospect_id,
            p.full_name, p.headline, p.company_name, p.linkedin_url, p.email,
            p.sequence_paused_at, p.sequence_pause_reason,
            t.gmail_thread_url, t.email_message_id, t.provider_thread_id,
            t.channel AS touch_channel,
            NULL::TEXT AS founder_verdict
       FROM event e
       LEFT JOIN prospect p ON p.id = e.prospect_id
       LEFT JOIN touch t ON t.id = e.touch_id
      WHERE e.id = $1::BIGINT`,
    [eventId],
  );
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------- metrics -- */

interface TouchFactRow {
  touch_id: number;
  prospect_id: number;
  channel: 'email' | 'dm' | 'connect';
  persona: string | null;
  template_version: string;
  angle: string | null;
  seed_account_id: number | null;
  signal_type: string | null;
  latency_bucket: string | null;
  match_count: number | null;
  founder_edited: boolean;
  sent_at: Date | null;
  dry_run: boolean;
}

export async function touchFacts(client?: Q): Promise<TouchFact[]> {
  const { rows } = await q(client).query<TouchFactRow>(
    `SELECT t.id AS touch_id, t.prospect_id, t.channel, t.persona, t.template_version,
            t.angle, t.seed_account_id, t.signal_type, t.latency_bucket,
            mr.match_count, t.founder_edited, t.sent_at, t.dry_run
       FROM touch t
       LEFT JOIN match_run mr ON mr.id = t.match_run_id`,
  );
  return rows.map((r) => ({
    touchId: r.touch_id,
    prospectId: r.prospect_id,
    channel: r.channel,
    persona: r.persona,
    templateVersion: r.template_version,
    angle: r.angle,
    seedAccountId: r.seed_account_id,
    signalType: r.signal_type,
    latencyBucket: r.latency_bucket,
    matchCount: r.match_count,
    founderEdited: r.founder_edited,
    sentAt: r.sent_at,
    dryRun: r.dry_run,
  }));
}

export async function eventFacts(client?: Q): Promise<EventFact[]> {
  const { rows } = await q(client).query<{
    touch_id: number | null;
    prospect_id: number | null;
    kind: string;
    occurred_at: Date;
  }>(`SELECT touch_id, prospect_id, kind, occurred_at FROM event`);
  return rows.map((r) => ({
    touchId: r.touch_id,
    prospectId: r.prospect_id,
    kind: r.kind,
    occurredAt: r.occurred_at,
  }));
}

export async function seedSlugs(client?: Q): Promise<Map<number, string>> {
  const { rows } = await q(client).query<{ id: number; slug: string }>(
    `SELECT id, slug FROM seed_account`,
  );
  return new Map(rows.map((r) => [r.id, r.slug]));
}

/* ------------------------------------------------------------------ login -- */

export async function recentLoginAttempts(
  ip: string,
  since: Date,
  client?: Q,
): Promise<Array<{ success: boolean; at: Date }>> {
  const { rows } = await q(client).query<{ success: boolean; at: Date }>(
    `SELECT success, at FROM login_attempt
      WHERE ip = $1 AND at >= $2
      ORDER BY at DESC
      LIMIT 500`,
    [ip, since],
  );
  return rows;
}

/** EVERY attempt is recorded — the successful ones are the audit trail. */
export async function recordLoginAttempt(
  actor: string | null,
  ip: string,
  success: boolean,
  client?: Q,
): Promise<void> {
  await q(client).query(`INSERT INTO login_attempt (actor, ip, success) VALUES ($1,$2,$3)`, [
    actor,
    ip,
    success,
  ]);
}
