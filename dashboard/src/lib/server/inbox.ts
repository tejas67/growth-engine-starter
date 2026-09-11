import type { PoolClient } from 'pg';
import { db } from '../../../../db/client.js';
import type { TouchRow } from '../../../../src/repo/index.js';
import { PAGE_SIZE, pageWindow, searchPattern, type queueParams } from '../inbox.js';
type Q = Pick<PoolClient, 'query'>;
type Filters = ReturnType<typeof queueParams>;
// Same eligibility as the engine. All decisions use the existing audited transitions.
const eligible = "t.status = 'draft' AND p.sequence_paused_at IS NULL";
const matching = `($1 = '' OR concat_ws(' ', p.full_name, p.company_name, p.headline, p.company_domain) ILIKE $2)
  AND ($3 = 'all' OR ($3 = 'dm' AND t.channel IN ('dm', 'connect')) OR t.channel = $3)`;
export async function reviewQueue(filters: Filters, client: Q = db()) {
  const values = [filters.q, searchPattern(filters.q), filters.channel];
  const counts = (
    await client.query<{ all: number; priority: number }>(
      `SELECT count(*)::int AS all, count(*) FILTER (WHERE t.hot)::int AS priority
     FROM touch t JOIN prospect p ON p.id = t.prospect_id WHERE ${eligible} AND ${matching}`,
      values,
    )
  ).rows[0]!;
  const total = counts[filters.filter];
  const window = pageWindow(filters.page, total);
  const { rows } = await client.query<TouchRow>(
    `SELECT t.* FROM touch t JOIN prospect p ON p.id = t.prospect_id
     WHERE ${eligible} AND ${matching} AND ($4 = 'all' OR t.hot)
     ORDER BY t.drafted_at ${filters.sort === 'oldest' ? 'ASC' : 'DESC'}, t.id ${filters.sort === 'oldest' ? 'ASC' : 'DESC'}
     LIMIT $5 OFFSET $6`,
    [...values, filters.filter, PAGE_SIZE, window.offset],
  );
  return { rows, counts, total, ...window };
}
export async function workspaceCounts(client: Q = db()) {
  const { rows } = await client.query<{ drafts: number; conversations: number }>(
    `SELECT
      (SELECT count(*)::int FROM touch t JOIN prospect p ON p.id = t.prospect_id WHERE ${eligible}) AS drafts,
      (SELECT count(DISTINCT prospect_id)::int FROM event
       WHERE kind IN ('reply', 'positive_reply', 'negative_reply', 'neutral_reply') AND source <> 'dashboard') AS conversations`,
  );
  return rows[0]!;
}

export interface ReplyListRow {
  event_id: string;
  prospect_id: number | null;
  full_name: string | null;
  company_name: string | null;
  headline: string | null;
  linkedin_url: string | null;
  email: string | null;
  sequence_paused_at: Date | null;
  sequence_pause_reason: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: Date;
  channel: string | null;
}
export async function replyInbox(params: URLSearchParams, client: Q = db()) {
  const view = params.get('view') === 'unmatched' ? 'unmatched' : 'conversations';
  const query = (params.get('q') ?? '').trim().slice(0, 120);
  const requested = Number(params.get('page')) || 1;
  const values = [query, searchPattern(query)];
  const source = `FROM event e LEFT JOIN prospect p ON p.id = e.prospect_id
    WHERE e.source <> 'dashboard' AND e.kind IN ('reply','positive_reply','negative_reply','neutral_reply','unmatched_reply')
    AND ($1 = '' OR concat_ws(' ',p.full_name,p.company_name,p.email,e.payload->>'from',e.payload->>'subject') ILIKE $2)`;
  const counts = (
    await client.query<{ conversations: number; unmatched: number }>(
      `SELECT count(DISTINCT e.prospect_id) FILTER (WHERE e.kind <> 'unmatched_reply')::int AS conversations,
     count(*) FILTER (WHERE e.kind = 'unmatched_reply' OR e.prospect_id IS NULL)::int AS unmatched ${source}`,
      values,
    )
  ).rows[0]!;
  const total = counts[view];
  const window = pageWindow(Number.isSafeInteger(requested) ? requested : 1, total);
  const columns = `e.id::text AS event_id, e.prospect_id, p.full_name, p.company_name, p.headline,
    p.linkedin_url,p.email,p.sequence_paused_at,p.sequence_pause_reason,e.payload,e.occurred_at,e.channel`;
  const select =
    view === 'conversations'
      ? `SELECT DISTINCT ON (e.prospect_id) ${columns} ${source} AND e.kind <> 'unmatched_reply' AND e.prospect_id IS NOT NULL
       ORDER BY e.prospect_id, e.occurred_at DESC, e.id DESC`
      : `SELECT ${columns} ${source} AND (e.kind = 'unmatched_reply' OR e.prospect_id IS NULL)`;
  const { rows } = await client.query<ReplyListRow>(
    `SELECT * FROM (${select}) messages ORDER BY occurred_at DESC, event_id::bigint DESC LIMIT $3 OFFSET $4`,
    [...values, PAGE_SIZE, window.offset],
  );
  return { rows, counts, view, query, total, ...window };
}
