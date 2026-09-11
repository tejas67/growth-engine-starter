import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDb } from '../db/client.js';
import { up } from '../db/migrate.js';
import { recoverDraftHolds } from '../src/pipeline/draft_recovery.js';
import { refreshDrafts } from '../src/pipeline/refresh_drafts.js';
import { insertTouch, upsertProspect } from '../src/repo/index.js';
import { productionUnipileLedger } from '../src/clients/unipile_ledger.js';
import { UnipileError } from '../src/clients/unipile.js';
import { config } from '../config/index.js';
import { runDraft } from '../src/pipeline/stages.js';
import { ClaudeError } from '../src/clients/claude.js';
describe.skipIf(process.env.GROWTH_INTEGRATION_TESTS !== '1')('database recovery and account budgets', () => {
    beforeAll(async () => {
        if (!new URL(config.database.url).pathname.includes('growth_test_'))
            throw new Error('Dedicated growth_test_ database required');
        await up();
    });
    afterAll(closeDb);
    async function prospect(extraHold = false, detail = 'transport: claude exited 1: ', paused = false) {
        const { rows: [p] } = await db().query(`INSERT INTO prospect(state,sequence_paused_at)
      VALUES ('held',CASE WHEN $1 THEN NOW() END) RETURNING id`, [paused]);
        await db().query(`INSERT INTO icp_assessment(prospect_id,rubric_version,score,persona,reasoning,stage)
      VALUES ($1,'test',80,'P1','test','pre_enrich')`, [p.id]);
        await db().query(`INSERT INTO pipeline_hold(subject_kind,subject_id,stage,reason,detail,created_at)
      VALUES ('prospect',$1,'draft','hold',$2,NOW()-INTERVAL '2 hours')`, [p.id, JSON.stringify({ detail })]);
        if (extraHold)
            await db().query(`INSERT INTO pipeline_hold(subject_kind,subject_id,stage,reason)
      VALUES ('prospect',$1,'verify','contradicted')`, [p.id]);
        return p.id as number;
    }
    it('requeues old provider failures with their assessment intact and preserves content/other holds and pauses', async () => {
        const ids = [await prospect(), await prospect(true), await prospect(false, 'malformed: invalid output'),
            await prospect(false, 'rate_limit: exhausted', true)];
        expect(await recoverDraftHolds()).toBe(1);
        expect(await recoverDraftHolds()).toBe(0);
        const { rows } = await db().query('SELECT state FROM prospect WHERE id=ANY($1) ORDER BY id', [ids]);
        expect(rows.map(r => r.state)).toEqual(['scored', 'held', 'held', 'held']);
        const { rows: [counts] } = await db().query(`SELECT
      (SELECT COUNT(*)::int FROM icp_assessment WHERE prospect_id=ANY($1)) AS assessments,
      (SELECT COUNT(*)::int FROM pipeline_hold WHERE subject_id=ANY($1) AND resolved_at IS NULL) AS holds`, [ids]);
        expect(counts).toEqual({ assessments: 4, holds: 2 });
    });
    it('persists the generating model separately from copy version, leaving unknown history null', async () => {
        const id = await prospect();
        const input = { prospectId: id, channel: 'dm' as const, templateVersion: 'B-intro@v7',
            angle: 'A1', persona: 'P1', seedAccountId: null, signalType: 'like', latencyBucket: null,
            latencyFromDetection: null, matchRunId: null, noProof: true, subject: null, body: 'Test draft',
            connectNote: 'Test note', hot: false, sequenceStep: 1, dryRun: true };
        const generated = await insertTouch({ ...input, generationProvider: 'codex', generationModel: 'gpt-6-astra' });
        const legacy = await insertTouch(input);
        expect(generated).toMatchObject({ generation_provider: 'codex', generation_model: 'gpt-6-astra', template_version: 'B-intro@v7' });
        expect(legacy.generation_provider).toBeNull();
        expect(legacy.generation_model).toBeNull();
    });
    it('stops one unavailable provider batch without holding its queued prospects', async () => {
        const { rows: [post] } = await db().query("INSERT INTO post(linkedin_post_id) VALUES ('test-draft-outage') RETURNING id");
        const ids = [];
        for (let i = 0; i < 2; i++) {
            const id = await prospect();
            ids.push(id);
            await db().query("UPDATE prospect SET state='scored' WHERE id=$1", [id]);
            await db().query("INSERT INTO engagement(post_id,prospect_id,engagement_type) VALUES ($1,$2,'like')", [post.id, id]);
        }
        const { rows: [before] } = await db().query('SELECT COUNT(*) FROM pipeline_hold');
        let calls = 0;
        expect(await runDraft(async () => { calls++; throw new ClaudeError('both providers unavailable', 'rate_limit'); }))
            .toEqual({ drafted: 0, rejected: 0 });
        expect(calls).toBe(1);
        const { rows } = await db().query('SELECT state FROM prospect WHERE id=ANY($1)', [ids]);
        expect(rows.map(r => r.state)).toEqual(['scored', 'scored']);
        const { rows: [after] } = await db().query('SELECT COUNT(*) FROM pipeline_hold');
        expect(after.count).toBe(before.count);
    });
    it('resolves a public URL and subsequent thin sightings to one canonical prospect', async () => {
        const internal = 'https://www.linkedin.com/in/acoaabcdefghijklmnopqrstuv';
        const publicUrl = 'https://www.linkedin.com/in/integration-founder';
        const input = { linkedinUrl: internal, linkedinSlug: null, fullName: 'Test Founder', headline: 'Founder',
            location: null, countryClass: 'unknown' as const, isCompanyPage: false, companyName: null, profileJson: { id: 'ACoAAbCdEfGhIjKlMnOpQrStUv' } };
        const first = await upsertProspect(input);
        const upgraded = await upsertProspect({ ...input, linkedinUrl: publicUrl, linkedinSlug: 'integration-founder', aliasUrls: [internal] });
        const repeat = await upsertProspect(input);
        expect([upgraded.id, repeat.id]).toEqual([first.id, first.id]);
        const { rows: [row] } = await db().query('SELECT linkedin_url FROM prospect WHERE id=$1', [first.id]);
        expect(row.linkedin_url).toBe(publicUrl);
    });
    it('merges existing alias rows without losing engagement, score, or pause history', async () => {
        const internal = 'https://www.linkedin.com/in/acoaabcdefghijklmnopqrstuw';
        const publicUrl = 'https://www.linkedin.com/in/integration-merge';
        const input = { linkedinUrl: internal, linkedinSlug: null, fullName: 'Test Merge', headline: null,
            location: null, countryClass: 'unknown' as const, isCompanyPage: false, companyName: null, profileJson: null };
        const first = await upsertProspect(input);
        const second = await upsertProspect({ ...input, linkedinUrl: publicUrl });
        const { rows: [post] } = await db().query("INSERT INTO post(linkedin_post_id) VALUES ('test-merge') RETURNING id");
        await db().query(`INSERT INTO engagement(post_id,prospect_id,engagement_type) VALUES ($1,$2,'like'),($1,$3,'like'),($1,$3,'comment')`, [post.id, first.id, second.id]);
        await db().query(`INSERT INTO icp_assessment(prospect_id,rubric_version,score,persona,reasoning,stage)
      VALUES ($1,'test',80,'P1','test','pre_enrich')`, [second.id]);
        await db().query("UPDATE prospect SET sequence_paused_at=NOW(),sequence_pause_reason='reply' WHERE id=$1", [second.id]);
        const merged = await upsertProspect({ ...input, linkedinUrl: publicUrl, aliasUrls: [internal] });
        expect(merged.id).toBe(first.id);
        const { rows: [state] } = await db().query(`SELECT linkedin_url,sequence_pause_reason,
      (SELECT COUNT(*)::int FROM engagement WHERE prospect_id=p.id) AS engagements,
      (SELECT COUNT(*)::int FROM icp_assessment WHERE prospect_id=p.id) AS scores FROM prospect p WHERE id=$1`, [first.id]);
        expect(state).toEqual({ linkedin_url: publicUrl, sequence_pause_reason: 'reply', engagements: 2, scores: 1 });
        expect((await upsertProspect(input)).id).toBe(first.id);
    });
    it('drafts a selected pilot from its own company evidence without consuming the rest of the queue', async () => {
        const { rows: [p] } = await db().query(`INSERT INTO prospect(state,full_name,company_name,company_domain,company_verified)
      VALUES ('scored','Alex Pilot','Pilot','pilot.example',true) RETURNING id`);
        await db().query(`INSERT INTO icp_assessment(prospect_id,rubric_version,score,persona,reasoning,stage)
      VALUES ($1,'test',80,'P1','test','pre_enrich')`, [p.id]);
        const { rows: [post] } = await db().query("INSERT INTO post(linkedin_post_id) VALUES ('test-copy-pilot') RETURNING id");
        await db().query("INSERT INTO engagement(post_id,prospect_id,engagement_type) VALUES ($1,$2,'like')", [post.id, p.id]);
        await db().query(`INSERT INTO company_verification(prospect_id,query,provider,verdict,verified_domain,evidence)
      VALUES ($1,'test','serper','verified','pilot.example',$2)`, [p.id, JSON.stringify([
                { title: 'Pilot', link: 'https://pilot.example', snippet: 'Mobile water treatment equipment for field use.' },
                { title: 'Different company', link: 'https://unrelated.example', snippet: 'Unrelated claim to exclude.' },
            ])]);
        let calls = 0;
        expect(await runDraft(async (prompt) => {
            calls++;
            expect(prompt).toContain('Mobile water treatment equipment for field use.');
            expect(prompt).not.toContain('Unrelated claim to exclude.');
            return JSON.stringify({ subject: null, body: "Alex, I'm building Growth Engine. I can check for federal programs that need water systems and send Pilot the relevant contacts. Want me to search?",
                connect_note: "Alex, I'm building Growth Engine and can check for federal programs relevant to Pilot's water systems.", shape: 'A-hw', angle: 'A1', rationale: 'Relevant product and useful search.' });
        }, new Date(), [p.id])).toEqual({ drafted: 1, rejected: 0 });
        expect(calls).toBe(1);
        const { rows: [touch] } = await db().query('SELECT template_version,body FROM touch WHERE prospect_id=$1', [p.id]);
        expect(touch.template_version).toMatch(/@v8$/);
        expect(touch.body).toContain('water systems');
    });
    it('refreshes old untouched copy with an audit, preserving approvals, edits, holds and newer versions', async () => {
        await refreshDrafts('v8', true);
        const ids: number[] = [];
        for (let i = 0; i < 10; i++) {
            const { rows: [p] } = await db().query(`INSERT INTO prospect(state,sequence_paused_at)
        VALUES ('drafted',CASE WHEN $1 THEN NOW() END) RETURNING id`, [i === 5]);
            const { rows: [t] } = await db().query(`INSERT INTO touch(prospect_id,channel,template_version,body,status,founder_edited,approved_at)
        VALUES ($1,'dm',$2,'Original copy',$3,$4,CASE WHEN $5 THEN NOW() END) RETURNING id`, [p.id, i === 7 ? 'A-hw@v8' : i === 8 ? 'A-hw@v9' : i === 9 ? 'B-intro@v6-primary' : 'A-hw@v7', i === 3 ? 'approved' : i === 4 ? 'sent' : 'draft', i === 1, i === 2 || i === 3]);
            ids.push(t.id);
            if (i === 6)
                await db().query(`INSERT INTO pipeline_hold(subject_kind,subject_id,stage,reason)
        VALUES ('prospect',$1,'draft','review needed')`, [p.id]);
        }
        expect(await refreshDrafts('v8')).toEqual({ eligible: 2, retired: 0, requeued: 0 });
        expect(await refreshDrafts('v8', true)).toEqual({ eligible: 2, retired: 2, requeued: 2 });
        expect(await refreshDrafts('v8', true)).toEqual({ eligible: 0, retired: 0, requeued: 0 });
        const { rows } = await db().query(`SELECT t.status,t.body,p.state FROM touch t JOIN prospect p ON p.id=t.prospect_id
      WHERE t.id=ANY($1) ORDER BY t.id`, [ids]);
        expect(rows[0]).toEqual({ status: 'skipped', body: 'Original copy', state: 'scored' });
        expect(rows.slice(1, 9).map(r => r.status)).toEqual(['draft', 'draft', 'approved', 'sent', 'draft', 'draft', 'draft', 'draft']);
        expect(rows[9]).toEqual({ status: 'skipped', body: 'Original copy', state: 'scored' });
        const { rows: audits } = await db().query("SELECT detail->>'to' AS version FROM approval_audit WHERE touch_id=ANY($1)", [ids]);
        expect(audits).toEqual([{ version: 'v8' }, { version: 'v8' }]);
    });
    it('atomically shares daily action and aggregate caps across concurrent clients', async () => {
        const clients = Array.from({ length: 8 }, () => productionUnipileLedger(async () => { }));
        const attempts = async (kind: 'reactions' | 'comments' | 'posts' | 'profile', count: number) => (await Promise.all(Array.from({ length: count }, (_, i) => clients[i % clients.length]!.admit(kind)))).filter(r => r.ok).length;
        expect(await attempts('reactions', 105)).toBe(100);
        expect(await attempts('comments', 105)).toBe(100);
        expect(await attempts('posts', 55)).toBe(50);
        expect(await attempts('profile', 105)).toBe(100);
    }, 20000);
    it('persists account cooldowns for a new client without reserving another call', async () => {
        const first = productionUnipileLedger(async () => { });
        await first.block!(new UnipileError('limited', 429));
        const second = productionUnipileLedger(async () => { });
        const result = await second.admit('profile');
        expect(result).toMatchObject({ ok: false });
        if (!result.ok)
            expect(result.reason).toContain('HTTP 429');
    });
});
