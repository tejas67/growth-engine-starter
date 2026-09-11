import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../../config/index.js';
import { db } from '../../db/client.js';
import { utcDay } from '../lib/time.js';
import { SELECTION_BIAS_NOTE } from '../metrics/funnels.js';
export interface SeedHealth {
    slug: string;
    cadenceClass: string;
    postsSeen: number;
    engagersSeen: number;
    consecutiveZeroDays: number;
    lastOutcome: string | null;
}
export interface SpendMeter {
    category: string;
    spentUsd: number;
    capUsd: number | null;
    units: number;
    capUnits?: number | null;
}
function capCell(m: SpendMeter): string {
    if (m.capUnits !== undefined && m.capUnits !== null) {
        return `${m.capUnits} calls (${pct(m.units, m.capUnits)})`;
    }
    return m.capUsd === null ? '—' : `$${m.capUsd.toFixed(2)} (${pct(m.spentUsd, m.capUsd)})`;
}
export interface DigestModel {
    day: string;
    generatedAt: Date;
    dryRun: boolean;
    seeds: SeedHealth[];
    prospects: {
        new: number;
        scored: number;
        verified: number;
        enriched: number;
    };
    drafts: {
        created: number;
        awaitingApproval: number;
        oldestDraftAgeHours: number | null;
    };
    sends: {
        dms: number;
        connects: number;
        emails: number;
        dryRunOnly: number;
    };
    replies: {
        total: number;
        unmatched: number;
        awaitingTriage: number;
    };
    holds: Array<{
        stage: string;
        count: number;
    }>;
    spend: SpendMeter[];
    tripwire: {
        emailLaneMode: string;
        hardBouncesInWindow: number;
        windowSize: number;
    };
    linkedin: {
        paused: boolean;
        reason: string | null;
    };
    alarms: string[];
}
function pct(n: number, d: number): string {
    return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`;
}
export function renderDigest(model: DigestModel): string {
    const lines: string[] = [];
    const L = (s = '') => lines.push(s);
    L(`# Hand-Raise Engine — ${model.day}`);
    L();
    if (model.dryRun) {
        L('> **DRY RUN IS ON.** Nothing in this report was transmitted to anyone.');
        L();
    }
    if (model.alarms.length > 0) {
        L('## Alarms');
        L();
        for (const alarm of model.alarms)
            L(`- ${alarm}`);
        L();
    }
    else {
        L('## Alarms');
        L();
        L('- none');
        L();
    }
    L('## Seed accounts');
    L();
    L('| seed | class | posts | engagers | zero-days | last run |');
    L('|---|---|---:|---:|---:|---|');
    for (const s of model.seeds) {
        const marker = s.engagersSeen === 0 ? ' ⚠ ZERO' : '';
        L(`| ${s.slug} | ${s.cadenceClass} | ${s.postsSeen} | ${s.engagersSeen}${marker} | ${s.consecutiveZeroDays} | ${s.lastOutcome ?? '—'} |`);
    }
    if (model.seeds.length === 0)
        L('| _no tracked seed accounts_ | | | | | |');
    L();
    L('## Pipeline');
    L();
    L(`- new prospects: **${model.prospects.new}**`);
    L(`- scored: ${model.prospects.scored} · company-verified: ${model.prospects.verified} · enriched: ${model.prospects.enriched}`);
    L(`- drafts created: ${model.drafts.created} · awaiting approval: **${model.drafts.awaitingApproval}**`);
    if (model.drafts.oldestDraftAgeHours !== null) {
        L(`- oldest unapproved draft: ${model.drafts.oldestDraftAgeHours.toFixed(1)}h old`);
    }
    L();
    L('## Sends');
    L();
    L(`- DMs ${model.sends.dms} · connects ${model.sends.connects} · emails ${model.sends.emails}`);
    if (model.sends.dryRunOnly > 0) {
        L(`- ${model.sends.dryRunOnly} touches went through the send path in DRY RUN (printed, not transmitted)`);
    }
    L(`- email lane: **${model.tripwire.emailLaneMode}** (${model.tripwire.hardBouncesInWindow} hard bounces in the last ${model.tripwire.windowSize} sends)`);
    L(`- LinkedIn campaign: ${model.linkedin.paused ? `**PAUSED** — ${model.linkedin.reason ?? 'no reason recorded'}` : 'running'}`);
    L();
    L('## Replies');
    L();
    L(`- ${model.replies.total} total · ${model.replies.awaitingTriage} awaiting founder triage · ${model.replies.unmatched} unmatched`);
    if (model.replies.unmatched > 0) {
        L('- unmatched replies are surfaced in the dashboard, never dropped — someone is waiting on an answer');
    }
    L();
    L('## Hold queue');
    L();
    if (model.holds.length === 0)
        L('- empty');
    for (const h of model.holds)
        L(`- ${h.stage}: **${h.count}**`);
    L();
    L('## Spend');
    L();
    L('| category | today | cap | units |');
    L('|---|---:|---:|---:|');
    for (const m of model.spend) {
        L(`| ${m.category} | $${m.spentUsd.toFixed(2)} | ${capCell(m)} | ${m.units} |`);
    }
    L();
    L('---');
    L();
    L(`_${SELECTION_BIAS_NOTE}_`);
    L();
    return lines.join('\n');
}
export async function collectDigest(now = new Date()): Promise<DigestModel> {
    const pool = db();
    const day = utcDay(now);
    const seeds = await pool.query<SeedHealth>(`SELECT s.slug,
            s.cadence_class AS "cadenceClass",
            COALESCE(r.posts, 0)::INT AS "postsSeen",
            COALESCE(e.engagers, 0)::INT AS "engagersSeen",
            s.consecutive_zero_days AS "consecutiveZeroDays",
            r.last_outcome AS "lastOutcome"
       FROM seed_account s
       LEFT JOIN LATERAL (
         SELECT SUM(results_count)::INT AS posts,
                (ARRAY_AGG(outcome ORDER BY started_at DESC))[1] AS last_outcome
           FROM scrape_run sr
          WHERE sr.seed_account_id = s.id AND sr.started_at::DATE = $1::DATE
       ) r ON TRUE
       LEFT JOIN LATERAL (
         -- Credit through post_seed_source, NOT post.discovered_via_seed_id: a
         -- repost-heavy seed's engagers attach to the ORIGINAL author's post row,
         -- which is usually discovered via a different seed. Attributing on the
         -- discovering seed alone makes every repost-heavy account read as a
         -- permanent zero — the exact failure this digest exists to surface.
         SELECT COUNT(*)::INT AS engagers
           FROM engagement en
           JOIN post_seed_source pss ON pss.post_id = en.post_id
          WHERE pss.seed_account_id = s.id AND en.detected_at::DATE = $1::DATE
       ) e ON TRUE
      WHERE s.active AND s.track
      ORDER BY s.tier, s.slug`, [day]);
    const counts = await pool.query<{
        new_prospects: string;
        scored: string;
        verified: string;
        enriched: string;
    }>(`SELECT
       (SELECT COUNT(*) FROM prospect WHERE first_detected_at::DATE = $1::DATE) AS new_prospects,
       (SELECT COUNT(*) FROM icp_assessment WHERE created_at::DATE = $1::DATE) AS scored,
       (SELECT COUNT(*) FROM company_verification WHERE created_at::DATE = $1::DATE AND verdict = 'verified') AS verified,
       (SELECT COUNT(*) FROM enrichment WHERE created_at::DATE = $1::DATE AND matched) AS enriched`, [day]);
    const drafts = await pool.query<{
        created: string;
        awaiting: string;
        oldest_hours: string | null;
    }>(`SELECT
       (SELECT COUNT(*) FROM touch WHERE drafted_at::DATE = $1::DATE) AS created,
       (SELECT COUNT(*) FROM touch WHERE status = 'draft') AS awaiting,
       (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(drafted_at)))/3600 FROM touch WHERE status = 'draft') AS oldest_hours`, [day]);
    const sends = await pool.query<{
        channel: string;
        count: string;
        dry: string;
    }>(`SELECT channel, COUNT(*) AS count, COUNT(*) FILTER (WHERE dry_run) AS dry
       FROM touch WHERE sent_at::DATE = $1::DATE GROUP BY channel`, [day]);
    const replies = await pool.query<{
        total: string;
        unmatched: string;
        triage: string;
    }>(`SELECT
       (SELECT COUNT(*) FROM event WHERE kind IN ('reply','positive_reply','negative_reply','neutral_reply') AND occurred_at::DATE = $1::DATE) AS total,
       (SELECT COUNT(*) FROM event WHERE kind = 'unmatched_reply' AND occurred_at::DATE = $1::DATE) AS unmatched,
       (SELECT COUNT(*) FROM prospect WHERE sequence_paused_at IS NOT NULL AND state = 'paused') AS triage`, [day]);
    const holds = await pool.query<{
        stage: string;
        count: string;
    }>(`SELECT stage, COUNT(*) AS count FROM pipeline_hold WHERE resolved_at IS NULL GROUP BY stage ORDER BY stage`);
    const spend = await pool.query<{
        category: string;
        total: string;
        units: string;
    }>(`SELECT category, SUM(amount_usd)::TEXT AS total, SUM(units)::TEXT AS units
       FROM spend_ledger WHERE day = $1::DATE GROUP BY category ORDER BY category`, [day]);
    const lane = await pool.query<{
        key: string;
        value: Record<string, unknown>;
    }>(`SELECT key, value FROM lane_state WHERE key IN ('email_lane_restriction','linkedin_campaign')`);
    const laneMap = new Map(lane.rows.map((r) => [r.key, r.value]));
    const bounces = await pool.query<{
        hard: string;
        window: string;
    }>(`WITH recent AS (
       SELECT t.id FROM touch t WHERE t.sent_at IS NOT NULL AND t.channel = 'email'
        ORDER BY t.sent_at DESC LIMIT $1
     )
     SELECT (SELECT COUNT(*) FROM event e WHERE e.kind = 'hard_bounced' AND e.touch_id IN (SELECT id FROM recent)) AS hard,
            (SELECT COUNT(*) FROM recent) AS window`, [config.guardrails.bounceTripwireWindow]);
    const sendRow = (channel: string): number => Number(sends.rows.find((r) => r.channel === channel)?.count ?? 0);
    const capFor: Record<string, number | null> = {
        apify: config.scrape.dailySpendCapUsd,
        match_run: config.bridge.seedCapPerDay * config.bridge.matchRunCostUsd,
        apollo: config.enrich.dailyCreditCap * config.enrich.costPerCreditUsd,
        serper: config.verify.dailyCap * config.verify.costPerSearchUsd,
        verify: null,
        claude: null,
    };
    const model: DigestModel = {
        day,
        generatedAt: now,
        dryRun: config.dryRun,
        seeds: seeds.rows,
        prospects: {
            new: Number(counts.rows[0]?.new_prospects ?? 0),
            scored: Number(counts.rows[0]?.scored ?? 0),
            verified: Number(counts.rows[0]?.verified ?? 0),
            enriched: Number(counts.rows[0]?.enriched ?? 0),
        },
        drafts: {
            created: Number(drafts.rows[0]?.created ?? 0),
            awaitingApproval: Number(drafts.rows[0]?.awaiting ?? 0),
            oldestDraftAgeHours: drafts.rows[0]?.oldest_hours ? Number(drafts.rows[0].oldest_hours) : null,
        },
        sends: {
            dms: sendRow('dm'),
            connects: sendRow('connect'),
            emails: sendRow('email'),
            dryRunOnly: sends.rows.reduce((acc, r) => acc + Number(r.dry), 0),
        },
        replies: {
            total: Number(replies.rows[0]?.total ?? 0),
            unmatched: Number(replies.rows[0]?.unmatched ?? 0),
            awaitingTriage: Number(replies.rows[0]?.triage ?? 0),
        },
        holds: holds.rows.map((r) => ({ stage: r.stage, count: Number(r.count) })),
        spend: spend.rows.map((r) => ({
            category: r.category,
            spentUsd: Number(r.total),
            capUsd: capFor[r.category] ?? null,
            capUnits: r.category === 'unipile' ? config.unipile.dailyCallCap :
                r.category === 'unipile_profile' ? config.unipile.dailyProfileCap : null,
            units: Number(r.units),
        })),
        tripwire: {
            emailLaneMode: String((laneMap.get('email_lane_restriction') as {
                mode?: string;
            })?.mode ?? 'all'),
            hardBouncesInWindow: Number(bounces.rows[0]?.hard ?? 0),
            windowSize: Number(bounces.rows[0]?.window ?? 0),
        },
        linkedin: {
            paused: Boolean((laneMap.get('linkedin_campaign') as {
                paused?: boolean;
            })?.paused),
            reason: ((laneMap.get('linkedin_campaign') as {
                reason?: string;
            })?.reason ?? null) as string | null,
        },
        alarms: [],
    };
    model.alarms = deriveAlarms(model);
    return model;
}
export function deriveAlarms(model: DigestModel): string[] {
    const alarms: string[] = [];
    const holdTotal = model.holds.reduce((a, h) => a + h.count, 0);
    if (holdTotal >= config.score.holdDepthAlarm) {
        alarms.push(`**hold queue is ${holdTotal} deep** (alarm at ${config.score.holdDepthAlarm}) — scoring or drafting is stalled, nothing is being lost but nothing is moving either`);
    }
    for (const seed of model.seeds) {
        if (seed.consecutiveZeroDays >= config.scrape.zeroDaysBeforeFlag) {
            alarms.push(`**${seed.slug}: ${seed.consecutiveZeroDays} consecutive zero-engager days** — verify the slug is alive (dead slug vs quiet account)`);
        }
    }
    if (model.tripwire.emailLaneMode === 'good_only') {
        alarms.push(`**bounce tripwire is TRIPPED** — email lane restricted to verified-good addresses (${model.tripwire.hardBouncesInWindow} hard bounces in the last ${model.tripwire.windowSize} sends)`);
    }
    if (model.linkedin.paused) {
        alarms.push(`**LinkedIn campaign is paused** — ${model.linkedin.reason ?? 'no reason recorded'}`);
    }
    if (model.replies.awaitingTriage > 0) {
        alarms.push(`${model.replies.awaitingTriage} prospect(s) paused awaiting your reply triage`);
    }
    if (model.replies.unmatched > 0) {
        alarms.push(`${model.replies.unmatched} reply/replies could not be matched to a touch — check the Replies view`);
    }
    for (const meter of model.spend) {
        if (meter.capUnits != null && meter.units >= meter.capUnits) {
            alarms.push(`**${meter.category} daily cap reached** (${meter.units}/${meter.capUnits} calls) — polling resumes next UTC day`);
        }
        if (meter.capUsd !== null && meter.spentUsd >= meter.capUsd) {
            alarms.push(`**${meter.category} daily cap reached** ($${meter.spentUsd.toFixed(2)} / $${meter.capUsd.toFixed(2)}) — cadence degraded, coverage preserved`);
        }
    }
    return alarms;
}
export async function writeDigest(markdown: string, day: string): Promise<string> {
    const dir = resolve(process.cwd(), config.report.outDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `digest-${day}.md`);
    await writeFile(path, markdown, 'utf8');
    return path;
}
export async function emailDigest(markdown: string): Promise<{
    sent: boolean;
    reason: string;
}> {
    if (!config.report.emailEnabled || config.report.recipients.length === 0) {
        return { sent: false, reason: 'digest email disabled (GROWTH_DIGEST_EMAIL_ENABLED=false)' };
    }
    console.log(`[digest] would email ${config.report.recipients.join(', ')} (${markdown.length} chars)`);
    return { sent: false, reason: 'digest email transport is a stub in the wave-1 scaffold' };
}
