import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { reviewQueue, replyInbox, workspaceCounts } from '../src/lib/server/inbox.js';
import { queueParams } from '../src/lib/inbox.js';

const enabled = process.env.GROWTH_DASHBOARD_DATABASE_TESTS === '1';
const url = process.env.GROWTH_DATABASE_URL ?? '';
if (enabled && !/\/growth_test_[a-z0-9_]+(?:\?|$)/i.test(url))
  throw new Error('Use a dedicated growth_test_ database.');
describe.skipIf(!enabled)('dashboard inbox database regressions', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    client = await pool.connect();
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });
  beforeEach(async () => {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(`
      INSERT INTO prospect(full_name,company_name,company_domain,sequence_paused_at)
      SELECT CASE n WHEN 1 THEN '100% Real' WHEN 2 THEN '100X Real' WHEN 3 THEN 'under_score' ELSE 'Test person '||n END,
      'Test company '||n, 'company-'||n||'.example',CASE WHEN n=31 THEN now() ELSE NULL END
      FROM generate_series(1,31) n RETURNING id`);
    const ids = rows.map((r) => r.id);
    await client.query(
      `INSERT INTO touch(prospect_id,channel,template_version,body,hot,status,drafted_at)
      SELECT id,CASE WHEN n%5=0 THEN 'email' ELSE 'dm' END,'test@v1','A test message',n%2=0,
      CASE WHEN n=30 THEN 'approved' ELSE 'draft' END,now()-n*INTERVAL '1 hour'
      FROM unnest($1::int[]) WITH ORDINALITY AS p(id,n)`,
      [ids],
    );
    await client.query(
      `INSERT INTO event(event_key,prospect_id,kind,channel,source,payload,occurred_at) VALUES
      ('design-matched-1',$1,'reply','dm','heyreach','{"text":"Interested"}',now()-INTERVAL '2 hours'),
      ('design-matched-2',$2,'reply','email','imap','{"text":"Tell me more"}',now()-INTERVAL '3 hours'),
      ('design-matched-1-older',$1,'reply','dm','heyreach','{"text":"Earlier message"}',now()-INTERVAL '5 hours'),
      ('design-verdict',$1,'positive_reply','dm','dashboard','{}',now())`,
      [ids[0], ids[1]],
    );
    await client.query(`INSERT INTO event(event_key,kind,channel,source,payload,occurred_at)
      SELECT 'design-unmatched-'||n,'unmatched_reply','email','imap',
      jsonb_build_object('subject','Newsletter '||n,'from','news@example.com'),now()+n*INTERVAL '1 second'
      FROM generate_series(1,350) n`);
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('paginates the entire eligible queue and excludes paused or already approved drafts', async () => {
    const first = await reviewQueue(queueParams(new URLSearchParams()), client);
    const second = await reviewQueue(queueParams(new URLSearchParams('page=2')), client);
    expect(first.total).toBe(29);
    expect(first.counts.priority).toBe(14);
    expect(first.rows).toHaveLength(25);
    expect(second.rows).toHaveLength(4);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(29);
    expect(first.rows[0].drafted_at > first.rows[1].drafted_at).toBe(true);
    const stalePage = await reviewQueue(queueParams(new URLSearchParams('page=999')), client);
    expect(stalePage.page).toBe(2);
  });
  it('searches literal wildcards safely and combines channel and priority filters', async () => {
    const literal = await reviewQueue(queueParams(new URLSearchParams('q=100%25')), client);
    expect(literal.total).toBe(1);
    const underscore = await reviewQueue(queueParams(new URLSearchParams('q=under_score')), client);
    expect(underscore.total).toBe(1);
    const injection = await reviewQueue(
      queueParams(new URLSearchParams({ q: "' OR TRUE --" })),
      client,
    );
    expect(injection.total).toBe(0);
    const emails = await reviewQueue(
      queueParams(new URLSearchParams('channel=email&filter=priority')),
      client,
    );
    expect(emails.total).toBe(2);
    expect(emails.rows.every((r) => r.channel === 'email' && r.hot)).toBe(true);
  });
  it('keeps old campaign conversations visible even behind hundreds of newer unmatched messages', async () => {
    const inbox = await replyInbox(new URLSearchParams(), client);
    expect(inbox.counts).toEqual({ conversations: 2, unmatched: 350 });
    expect(inbox.rows).toHaveLength(2);
    expect(inbox.rows[0].payload?.text).toBe('Interested');
    expect(new Set(inbox.rows.map((r) => r.prospect_id)).size).toBe(2);
    expect(await workspaceCounts(client)).toEqual({ drafts: 29, conversations: 2 });
  });
  it('paginates unmatched mail independently and supports sender search', async () => {
    const first = await replyInbox(
      new URLSearchParams('view=unmatched&q=news%40example.com'),
      client,
    );
    const second = await replyInbox(
      new URLSearchParams('view=unmatched&q=news%40example.com&page=2'),
      client,
    );
    expect(first.total).toBe(350);
    expect(first.rows).toHaveLength(25);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.event_id)).size).toBe(50);
    expect(first.counts.conversations).toBe(0);
    expect((await replyInbox(new URLSearchParams('view=unmatched&page=999'), client)).page).toBe(
      14,
    );
  });
});
