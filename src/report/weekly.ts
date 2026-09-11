import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { businessContext, projectRoot } from '../../config/local.js';
import { liveAiRunner } from '../clients/ai.js';
import { config } from '../../config/index.js';
import { db } from '../../db/client.js';
import { cliRunner, ClaudeError, type ClaudeRunner } from '../clients/claude.js';
import { buildFunnel, cutBy, graduationVerdicts, SELECTION_BIAS_NOTE, type Cell, type EventFact, type GraduationVerdict, type LaneFunnel, type TouchFact, } from '../metrics/funnels.js';
import { logger } from '../lib/log.js';
const log = logger('weekly');
export function isoWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
export function isoWeekStart(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - (day - 1));
    return d;
}
export interface ExploratoryCut {
    title: string;
    description: string;
    cells: Cell[];
}
export interface PipelineHealth {
    prospectsByState: Array<{
        state: string;
        count: number;
    }>;
    holdsByStage: Array<{
        stage: string;
        count: number;
    }>;
    apollo: {
        attempts: number;
        matches: number;
        hitRate: number | null;
    };
    emailReach: {
        seeded: number;
        noProof: number;
        awaitingApproval: number;
        sent: number;
    };
    silentSeeds: Array<{
        slug: string;
        consecutiveZeroDays: number;
    }>;
}
export interface WeeklyModel {
    week: string;
    windowStart: Date;
    windowEnd: Date;
    generatedAt: Date;
    dryRun: boolean;
    volumes: {
        sends: number;
        sendsPreviousWeek: number;
        byChannel: Array<{
            channel: string;
            count: number;
        }>;
        replies: number;
        positiveReplies: number;
        claims: number;
        signups: number;
        meetings: number;
    };
    funnels: LaneFunnel[];
    primary: Cell[];
    exploratory: ExploratoryCut[];
    graduation: GraduationVerdict[];
    health: PipelineHealth;
    narrative: {
        text: string | null;
        reason: string;
    };
}
interface TouchRow {
    id: number;
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
export async function collectWeekly(now = new Date()): Promise<WeeklyModel> {
    const pool = db();
    const windowStart = isoWeekStart(now);
    const windowEnd = now;
    const previousStart = new Date(windowStart.getTime() - 7 * 86400000);
    const touches = await pool.query<TouchRow>(`SELECT t.id, t.prospect_id, t.channel, t.persona, t.template_version, t.angle,
            t.seed_account_id, t.signal_type, t.latency_bucket, m.match_count,
            t.founder_edited, t.sent_at, t.dry_run
       FROM touch t
       LEFT JOIN match_run m ON m.id = t.match_run_id
      WHERE t.sent_at IS NOT NULL
      ORDER BY t.sent_at`);
    const events = await pool.query<{
        touch_id: number | null;
        prospect_id: number | null;
        kind: string;
        occurred_at: Date;
    }>(`SELECT touch_id, prospect_id, kind, occurred_at FROM event ORDER BY occurred_at`);
    const allFacts: TouchFact[] = touches.rows.map((r) => ({
        touchId: r.id,
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
    const eventFacts: EventFact[] = events.rows.map((r) => ({
        touchId: r.touch_id,
        prospectId: r.prospect_id,
        kind: r.kind,
        occurredAt: r.occurred_at,
    }));
    const inWindow = (fact: TouchFact): boolean => fact.sentAt !== null && fact.sentAt >= windowStart && fact.sentAt <= windowEnd && !fact.dryRun;
    const weekFacts = allFacts.filter(inWindow);
    const previousWeekFacts = allFacts.filter((f) => f.sentAt !== null && f.sentAt >= previousStart && f.sentAt < windowStart && !f.dryRun);
    const weekTouchIds = new Set(weekFacts.map((f) => f.touchId));
    const weekEvents = eventFacts.filter((e) => e.occurredAt >= windowStart && e.occurredAt <= windowEnd);
    const countKind = (kind: string): number => weekEvents.filter((e) => e.kind === kind && (e.touchId === null || weekTouchIds.has(e.touchId))).length;
    const byChannel = new Map<string, number>();
    for (const fact of weekFacts)
        byChannel.set(fact.channel, (byChannel.get(fact.channel) ?? 0) + 1);
    const health = await collectHealth(windowStart);
    return {
        week: isoWeekKey(now),
        windowStart,
        windowEnd,
        generatedAt: now,
        dryRun: config.dryRun,
        volumes: {
            sends: weekFacts.length,
            sendsPreviousWeek: previousWeekFacts.length,
            byChannel: [...byChannel.entries()].map(([channel, count]) => ({ channel, count })),
            replies: countKind('reply') + countKind('positive_reply') + countKind('negative_reply'),
            positiveReplies: countKind('positive_reply'),
            claims: countKind('claimed'),
            signups: countKind('signed_in'),
            meetings: countKind('meeting_booked'),
        },
        funnels: [buildFunnel('email', allFacts, eventFacts), buildFunnel('dm', allFacts, eventFacts)],
        primary: cutBy(allFacts, eventFacts, (t) => t.persona),
        exploratory: [
            {
                title: 'Angle',
                description: 'one row per copy angle (A1 opportunities-find-you, A2 the-person-to-talk-to, ...)',
                cells: cutBy(allFacts, eventFacts, (t) => t.angle),
            },
            {
                title: 'Seed account',
                description: 'one row per seed account whose post produced the signal',
                cells: cutBy(allFacts, eventFacts, (t) => t.seedAccountId === null ? null : `seed ${t.seedAccountId}`),
            },
            {
                title: 'Signal type',
                description: 'did they comment or only react',
                cells: cutBy(allFacts, eventFacts, (t) => t.signalType),
            },
            {
                title: 'Latency band',
                description: 'time from OUR detection of the signal to the touch — not from their click',
                cells: cutBy(allFacts, eventFacts, (t) => t.latencyBucket),
            },
            {
                title: 'Match-count band',
                description: 'how many live opportunities the product-proof email could name',
                cells: cutBy(allFacts, eventFacts, (t) => matchBand(t.matchCount)),
            },
        ],
        graduation: graduationVerdicts(allFacts, eventFacts),
        health,
        narrative: { text: null, reason: 'not requested' },
    };
}
function matchBand(count: number | null): string | null {
    if (count === null)
        return null;
    if (count === 0)
        return '0 (no proof)';
    if (count <= 3)
        return '1-3';
    if (count <= 10)
        return '4-10';
    return '11+';
}
async function collectHealth(windowStart: Date): Promise<PipelineHealth> {
    const pool = db();
    const [states, holds, apollo, email, seeds] = await Promise.all([
        pool.query<{
            state: string;
            count: string;
        }>(`SELECT state, COUNT(*)::TEXT AS count FROM prospect GROUP BY state ORDER BY COUNT(*) DESC`),
        pool.query<{
            stage: string;
            count: string;
        }>(`SELECT stage, COUNT(*)::TEXT AS count FROM pipeline_hold WHERE resolved_at IS NULL GROUP BY stage`),
        pool.query<{
            attempts: string;
            matches: string;
        }>(`SELECT COUNT(*)::TEXT AS attempts,
              COUNT(*) FILTER (WHERE matched)::TEXT AS matches
         FROM enrichment WHERE provider = 'apollo' AND created_at >= $1`, [windowStart]),
        pool.query<{
            state: string;
            count: string;
        }>(`SELECT state, COUNT(*)::TEXT AS count FROM match_run GROUP BY state`),
        pool.query<{
            slug: string;
            consecutive_zero_days: number;
        }>(`SELECT slug, consecutive_zero_days FROM seed_account
        WHERE active AND track AND consecutive_zero_days >= $1
        ORDER BY consecutive_zero_days DESC`, [config.scrape.zeroDaysBeforeFlag]),
    ]);
    const attempts = Number(apollo.rows[0]?.attempts ?? 0);
    const matches = Number(apollo.rows[0]?.matches ?? 0);
    const stateCount = (name: string): number => Number(email.rows.find((r) => r.state === name)?.count ?? 0);
    return {
        prospectsByState: states.rows.map((r) => ({ state: r.state, count: Number(r.count) })),
        holdsByStage: holds.rows.map((r) => ({ stage: r.stage, count: Number(r.count) })),
        apollo: { attempts, matches, hitRate: attempts === 0 ? null : matches / attempts },
        emailReach: {
            seeded: email.rows.reduce((sum, r) => sum + Number(r.count), 0),
            noProof: stateCount('no_proof'),
            awaitingApproval: stateCount('awaiting_approval'),
            sent: stateCount('sent'),
        },
        silentSeeds: seeds.rows.map((r) => ({ slug: r.slug, consecutiveZeroDays: r.consecutive_zero_days })),
    };
}
function sends(n: number): string {
    return `${n} ${n === 1 ? 'send' : 'sends'}`;
}
function rate(cell: Cell): string {
    return cell.positiveRate === null
        ? `— (${sends(cell.sends)}: below the ${config.dashboard.minCellN}-send floor)`
        : `${(cell.positiveRate * 100).toFixed(1)}%`;
}
function cellTable(cells: Cell[]): string[] {
    if (cells.length === 0)
        return ['_No sends to cut yet._', ''];
    const lines = ['| cell | sends | replies | positive | positive-reply rate |', '|---|---|---|---|---|'];
    for (const cell of cells) {
        lines.push(`| ${cell.key} | ${cell.sends} | ${cell.replies} | ${cell.positive} | ${rate(cell)} |`);
    }
    lines.push('');
    return lines;
}
export function renderWeekly(model: WeeklyModel): string {
    const lines: string[] = [];
    const L = (s = '') => lines.push(s);
    L(`# Weekly readout — ${model.week}`);
    L();
    L(`Week of ${model.windowStart.toISOString().slice(0, 10)}, generated ${model.generatedAt.toISOString()}.`);
    if (model.dryRun) {
        L();
        L('> **DRY RUN IS ON.** Nothing counted here was transmitted to anybody.');
    }
    L();
    L('## What happened');
    L();
    L(`- **${sends(model.volumes.sends)}** this week (previous week: ${sends(model.volumes.sendsPreviousWeek)}).`);
    for (const channel of model.volumes.byChannel) {
        L(`  - ${channel.channel}: ${channel.count}`);
    }
    L(`- ${model.volumes.replies} replies, of which **${model.volumes.positiveReplies} positive**.`);
    L(`- ${model.volumes.claims} claims, ${model.volumes.signups} sign-ins, ${model.volumes.meetings} meetings booked.`);
    L();
    L('## The primary read — positive-reply rate by persona');
    L();
    L('This metric and this cut were predeclared before any data existed. Everything below');
    L('this section is exploratory and labelled as such.');
    L();
    lines.push(...cellTable(model.primary));
    const anyPrimary = model.primary.some((c) => !c.belowFloor);
    if (!anyPrimary) {
        L('**No persona cell clears the reporting floor yet.** The honest read of this week is');
        L('that it was too small to read. Counts above; no rates, because a rate off this');
        L('denominator would be noise wearing a percentage sign.');
        L();
    }
    L('## Lane funnels');
    L();
    for (const funnel of model.funnels) {
        L(`### ${funnel.lane === 'email' ? 'Product-proof email lane' : 'DM lane'}`);
        L();
        L(`_${funnel.note}_`);
        L();
        L('| stage | count | share of previous |');
        L('|---|---|---|');
        for (const stage of funnel.stages) {
            L(`| ${stage.name} | ${stage.count} | ${stage.rate === null ? '—' : `${(stage.rate * 100).toFixed(1)}%`} |`);
        }
        L();
    }
    L('## Exploratory cuts');
    L();
    L('**Every cut in this section is exploratory.** At this volume most cells are empty,');
    L('and a cell below the floor shows its counts with no rate.');
    L();
    for (const cut of model.exploratory) {
        L(`### ${cut.title} _(exploratory)_`);
        L();
        L(cut.description);
        L();
        lines.push(...cellTable(cut.cells));
    }
    L('## Template graduation readiness');
    L();
    L('Per template x persona, never aggregate — a template proven on P1 founders is');
    L('unproven on P2 owners. **Founder-edited sends are excluded**: an edited touch');
    L('measures the founder\'s writing, not the template\'s. These are recommendations;');
    L('the founder throws the switch.');
    L();
    if (model.graduation.length === 0) {
        L('_Nothing sent yet, so nothing to graduate._');
        L();
    }
    else {
        L('| template | persona | sends | positive | verdict | note |');
        L('|---|---|---|---|---|---|');
        for (const verdict of model.graduation) {
            L(`| ${verdict.templateVersion} | ${verdict.persona} | ${verdict.sends} | ${verdict.positive} | **${verdict.recommendation}** | ${verdict.note} |`);
        }
        L();
    }
    L('## Pipeline health');
    L();
    L(`- Prospects by state: ${model.health.prospectsByState.map((s) => `${s.state} ${s.count}`).join(', ') || 'none'}`);
    L(`- Open holds: ${model.health.holdsByStage.map((h) => `${h.stage} ${h.count}`).join(', ') || 'none'}`);
    L(`- Apollo this week: ${model.health.apollo.matches}/${model.health.apollo.attempts} matched` +
        (model.health.apollo.hitRate === null
            ? ' (no attempts)'
            : ` (${(model.health.apollo.hitRate * 100).toFixed(0)}%${model.health.apollo.hitRate < config.enrich.hitRateFloor ? ' — below the waterfall floor' : ''})`));
    L(`- Email lane reach: ${model.health.emailReach.seeded} match runs, of which ` +
        `${model.health.emailReach.noProof} came back with no proof, ` +
        `${model.health.emailReach.awaitingApproval} awaiting your approval, ` +
        `${model.health.emailReach.sent} sent.`);
    if (model.health.silentSeeds.length > 0) {
        L(`- **Silent seed accounts**: ${model.health.silentSeeds
            .map((s) => `${s.slug} (${s.consecutiveZeroDays}d)`)
            .join(', ')} — a dead slug and a quiet account look identical from here.`);
    }
    else {
        L('- No seed account is past the zero-day flag.');
    }
    L();
    L('## The bias in every number above');
    L();
    L(SELECTION_BIAS_NOTE);
    L();
    L('## Analysis');
    L();
    if (model.narrative.text) {
        L(model.narrative.text.trim());
    }
    else {
        L(`_No written analysis this week: ${model.narrative.reason}._`);
        L();
        L('The tables above are complete and were computed from the database, not written by');
        L('a model. What is missing is the commentary — kill / scale / test-next — not data.');
    }
    L();
    return lines.join('\n');
}
export async function composeNarrative(model: WeeklyModel, runner: ClaudeRunner): Promise<{
    text: string | null;
    reason: string;
}> {
    const skill = await readFile(join(process.cwd(), 'skills', 'analyst.md'), 'utf8');
    const numbers = JSON.stringify({
        week: model.week,
        volumes: model.volumes,
        funnels: model.funnels,
        primaryCut: model.primary,
        exploratoryCuts: model.exploratory,
        graduation: model.graduation,
        health: model.health,
        reportingFloor: config.dashboard.minCellN,
        graduationThresholds: config.graduation,
    }, null, 2);
    const prompt = [
        'Write sections 5 ("Recommendations") and 6 ("What I could not tell you") of this',
        "week's readout, plus a two-sentence lead. The tables are already rendered; do not",
        'restate them and do not compute any rate that is not in the data below. A `null`',
        'rate means the cell is below the reporting floor: say "N sends" and stop.',
        '',
        '<computed_numbers>',
        numbers,
        '</computed_numbers>',
        '',
        'Reply with markdown only. No preamble, no headings above level 3.',
    ].join('\n');
    try {
        const text = await runner(prompt, skill);
        const trimmed = text.trim();
        if (!trimmed)
            return { text: null, reason: 'the model returned nothing' };
        return { text: trimmed, reason: 'written by Claude over the computed numbers' };
    }
    catch (err) {
        const reason = err instanceof ClaudeError ? `Claude ${err.kind}: ${err.message}` : (err as Error).message;
        log.warn('weekly narrative unavailable', { reason });
        return { text: null, reason };
    }
}
export function defaultAnalystRunner(): ClaudeRunner {
    return liveAiRunner();
}
export async function writeWeekly(markdown: string, week: string): Promise<string> {
    const dir = resolve(process.cwd(), config.report.outDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `weekly-${week}.md`);
    await writeFile(path, markdown, 'utf8');
    return path;
}
export async function runWeeklyAnalyst(opts: {
    now?: Date;
    runner?: ClaudeRunner | null;
} = {}): Promise<{
    path: string;
    week: string;
    markdown: string;
    narrated: boolean;
}> {
    const now = opts.now ?? new Date();
    const model = await collectWeekly(now);
    if (opts.runner !== null && config.analyst.mode === 'live') {
        model.narrative = await composeNarrative(model, opts.runner ?? defaultAnalystRunner());
    }
    else {
        model.narrative = {
            text: null,
            reason: opts.runner === null
                ? 'the analyst was run with commentary disabled'
                : `GROWTH_LLM_MODE is ${config.analyst.mode}, so no model was called`,
        };
    }
    const markdown = renderWeekly(model);
    const path = await writeWeekly(markdown, model.week);
    return { path, week: model.week, markdown, narrated: model.narrative.text !== null };
}
