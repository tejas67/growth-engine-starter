import { config } from '../../config/index.js';
import { db } from '../../db/client.js';
import { normalizeDomain } from '../lib/identity.js';
import { latencyBucket } from '../lib/time.js';
import { logger } from '../lib/log.js';
import * as repo from '../repo/index.js';
import { BridgeClient, BridgeError, bridgeEventsToOutcomes, campaignKeyFor, failureReasonOf, prospectRef, renderDrifted, renderedBytes, routeAfterRejection, routeAfterRequest, validatePush, type BridgeEvent, type RequestRow, } from './bridge.js';
import { planOutcomeSync, type SentTouchIndex } from './ingest.js';
const log = logger('bridge-stage');
export interface BridgeSummary {
    available: boolean;
    reason: string;
    seeded: number;
    reusedNoProof: number;
    localRefusals: number;
    polled: number;
    drafted: number;
    approvalsPushed: number;
    reRenders: number;
    platformFailures: number;
    eventsRecorded: number;
    unmatchedEvents: number;
    failures: number;
}
export interface BridgeDeps {
    client?: BridgeClient;
    now?: () => Date;
}
function emptySummary(available: boolean, reason: string): BridgeSummary {
    return {
        available,
        reason,
        seeded: 0,
        reusedNoProof: 0,
        localRefusals: 0,
        polled: 0,
        drafted: 0,
        approvalsPushed: 0,
        reRenders: 0,
        platformFailures: 0,
        eventsRecorded: 0,
        unmatchedEvents: 0,
        failures: 0,
    };
}
export async function runBridge(deps: BridgeDeps = {}): Promise<BridgeSummary> {
    const client = deps.client ?? BridgeClient.fromConfig();
    const now = deps.now ?? (() => new Date());
    if (!client.available) {
        return emptySummary(false, client.unavailableReason);
    }
    const summary = emptySummary(true, 'available');
    for (const [name, phase] of [
        ['seed', () => seedPhase(client, now(), summary)],
        ['poll', () => pollPhase(client, now(), summary)],
        ['approve', () => approvalPhase(client, summary)],
        ['events', () => eventPhase(client, summary)],
    ] as const) {
        try {
            await phase();
        }
        catch (err) {
            summary.failures += 1;
            const message = err instanceof BridgeError ? `${err.kind}: ${err.message}` : (err as Error).message;
            log.error('bridge phase failed', { phase: name, error: message });
            await repo.openHold({
                subjectKind: 'lane',
                subjectId: null,
                stage: 'bridge',
                reason: `bridge ${name} phase failed`,
                detail: { message },
            });
        }
    }
    return summary;
}
interface SeedCandidate {
    id: number;
    full_name: string | null;
    headline: string | null;
    email: string | null;
    company_name: string | null;
    company_domain: string | null;
    linkedin_url: string | null;
    score: number;
    persona: string;
    engagement_type: string | null;
    detected_at: Date | null;
    seed_account_id: number | null;
}
async function loadSeedCandidates(limit: number): Promise<SeedCandidate[]> {
    const { rows } = await db().query<SeedCandidate>(`SELECT * FROM (
       SELECT DISTINCT ON (p.id)
              p.id, p.full_name, p.headline, p.email, p.company_name, p.company_domain,
              p.linkedin_url, a.score, a.persona,
              e.engagement_type, e.detected_at, po.discovered_via_seed_id AS seed_account_id
         FROM prospect p
         JOIN LATERAL (
           SELECT score, persona FROM icp_assessment ia
            WHERE ia.prospect_id = p.id ORDER BY ia.created_at DESC LIMIT 1
         ) a ON TRUE
         LEFT JOIN engagement e ON e.prospect_id = p.id
         LEFT JOIN post po ON po.id = e.post_id
        WHERE p.state IN ('verified', 'enriched', 'drafted')
          AND p.canonical_prospect_id IS NULL
          AND p.sequence_paused_at IS NULL
          AND p.email IS NOT NULL
          AND p.company_verified
          AND NOT p.is_gov
          AND a.persona NOT IN ('P0', 'P4')
          AND a.score >= $1
          AND NOT EXISTS (SELECT 1 FROM match_run m WHERE m.requested_by_prospect_id = p.id)
        ORDER BY p.id, (e.engagement_type = 'comment') DESC, e.detected_at DESC
     ) c
     -- Commenters first, then by score: the same priority order the DM lane rations by.
     ORDER BY (c.engagement_type = 'comment') DESC, c.score DESC, c.detected_at DESC NULLS LAST
     LIMIT $2`, [config.score.seedScoreFloor, limit]);
    return rows;
}
function companyKeyFor(candidate: {
    company_domain: string | null;
    company_name: string | null;
}): string | null {
    const domain = normalizeDomain(candidate.company_domain);
    if (domain)
        return domain;
    const name = candidate.company_name?.trim().toLowerCase();
    return name ? `name:${name}` : null;
}
async function seedPhase(client: BridgeClient, now: Date, summary: BridgeSummary): Promise<void> {
    const pushedToday = await repo.seedsPushedToday(now);
    const remaining = Math.max(0, config.bridge.seedCapPerDay - pushedToday);
    if (remaining === 0) {
        log.info('seed cap reached for today — prospects wait, nothing is lost', {
            cap: config.bridge.seedCapPerDay,
        });
        return;
    }
    const campaignKey = campaignKeyFor();
    const candidates = await loadSeedCandidates(remaining * 2);
    for (const candidate of candidates) {
        if (summary.seeded >= remaining)
            break;
        const companyKey = companyKeyFor(candidate);
        if (!companyKey) {
            summary.localRefusals += 1;
            continue;
        }
        const ref = prospectRef(candidate.id);
        const run = await repo.upsertMatchRun({
            prospectRef: ref,
            prospectId: candidate.id,
            companyKey,
            companyName: candidate.company_name,
            companyDomain: normalizeDomain(candidate.company_domain),
            campaignKey,
            state: 'pending_seed',
            freshnessDays: config.bridge.matchFreshnessDays,
        });
        if (run.state !== 'pending_seed')
            continue;
        const reusable = await repo.freshNoProofForCompany(companyKey, config.bridge.matchFreshnessDays);
        if (reusable && reusable.id !== run.id) {
            await repo.updateMatchRun(run.id, {
                state: 'no_proof',
                failureReason: `reused the no-match verdict from run ${reusable.id} (same company, within ${config.bridge.matchFreshnessDays} days)`,
                reusedFromMatchRunId: reusable.id,
            });
            summary.reusedNoProof += 1;
            continue;
        }
        const website = normalizeDomain(candidate.company_domain);
        const push = {
            prospectRef: ref,
            campaignKey,
            company: { name: candidate.company_name, website: website ? `https://${website}` : null },
            contact: {
                email: candidate.email,
                firstName: candidate.full_name?.split(' ')[0] ?? null,
                lastName: candidate.full_name?.split(' ').slice(1).join(' ') || null,
                linkedinUrl: candidate.linkedin_url,
            },
            icpScore: candidate.score,
            persona: candidate.persona,
        };
        const valid = validatePush(push);
        if (!valid.ok) {
            await repo.updateMatchRun(run.id, { state: 'no_proof', failureReason: valid.reason });
            summary.localRefusals += 1;
            continue;
        }
        const result = await client.pushProspect(push);
        if (!result.ok) {
            if (result.status === 422) {
                const rejection = routeAfterRejection(result.code, result.reason);
                if (!rejection.known) {
                    log.warn('bridge refused a push with an intake code this build does not know', {
                        code: result.code,
                        reason: result.reason,
                        matchRunId: run.id,
                    });
                }
                await repo.updateMatchRun(run.id, {
                    state: 'no_proof',
                    failureReason: `bridge refused this prospect — ${rejection.reason}`,
                });
                summary.localRefusals += 1;
                continue;
            }
            await repo.updateMatchRun(run.id, {
                state: 'failed',
                failureReason: `bridge refused (${result.status}): ${result.reason}`,
            });
            summary.failures += 1;
            await repo.openHold({
                subjectKind: 'match_run',
                subjectId: run.id,
                stage: 'bridge',
                reason: 'bridge refused a prospect push',
                detail: { status: result.status, code: result.code, reason: result.reason },
            });
            continue;
        }
        await repo.updateMatchRun(run.id, {
            state: result.status,
            bridgeRowUuid: result.requestId,
            seeded: true,
            costUsd: config.bridge.matchRunCostUsd,
        });
        await repo.recordSpend('match_run', config.bridge.matchRunCostUsd, 1, {
            prospectId: candidate.id,
            companyKey,
        });
        summary.seeded += 1;
    }
}
async function pollPhase(client: BridgeClient, now: Date, summary: BridgeSummary): Promise<void> {
    const open = await repo.listOpenMatchRuns(config.bridge.pollLimit);
    for (const run of open) {
        const result = await client.getRequest(run.bridge_row_uuid!);
        if (!result.ok) {
            await repo.updateMatchRun(run.id, { state: 'failed', failureReason: result.reason, polled: true });
            await repo.openHold({
                subjectKind: 'match_run',
                subjectId: run.id,
                stage: 'bridge',
                reason: 'bridge no longer knows this request',
                detail: { requestId: run.bridge_row_uuid },
            });
            summary.failures += 1;
            continue;
        }
        summary.polled += 1;
        const row = result.row;
        const previousHash = run.content_hash;
        await mirrorRequestRow(run, row);
        const routing = routeAfterRequest(row);
        if (routing.failed) {
            await repo.updateMatchRun(run.id, {
                state: 'failed',
                failureReason: routing.reason,
                polled: true,
            });
            await repo.openHold({
                subjectKind: 'match_run',
                subjectId: run.id,
                stage: 'bridge',
                reason: 'the platform could not complete this match run',
                detail: { requestId: row.request_id, stageReason: failureReasonOf(row) },
            });
            summary.platformFailures += 1;
            continue;
        }
        if (routing.noProof) {
            await repo.updateMatchRun(run.id, {
                state: 'no_proof',
                failureReason: routing.reason,
                polled: true,
            });
            continue;
        }
        if (row.status === 'awaiting_approval' && run.touch_id === null) {
            const touchId = await createBridgeTouch(run, row, now);
            if (touchId !== null) {
                await repo.updateMatchRun(run.id, { touchId, polled: true });
                summary.drafted += 1;
            }
            continue;
        }
        if (renderDrifted(previousHash, row) && run.touch_id !== null) {
            await refreshTouchBytes(run.touch_id, row);
            await reopenForReapproval(run.touch_id, failureReasonOf(row) ?? 'the platform re-rendered this email with new numbers');
            summary.reRenders += 1;
            continue;
        }
        if (row.status === 'revalidation_failed' && run.touch_id !== null) {
            await reopenForReapproval(run.touch_id, failureReasonOf(row) ?? 'the platform re-checked the numbers and they moved');
            summary.reRenders += 1;
        }
    }
}
async function mirrorRequestRow(run: repo.MatchRunRow, row: RequestRow): Promise<void> {
    const total = row.headline_total_usd === null || row.headline_total_usd === undefined
        ? null
        : Number(row.headline_total_usd);
    await repo.updateMatchRun(run.id, {
        state: row.status,
        matchCount: row.match_count ?? null,
        potentialTotalUsd: Number.isFinite(total as number) ? (total as number) : null,
        payload: row.top_matches === undefined ? undefined : { top_matches: row.top_matches ?? null },
        renderedSubject: row.rendered_subject ?? null,
        renderedBody: row.rendered_body_text ?? null,
        renderedBodyHtml: row.rendered_body_html ?? null,
        contentHash: row.content_hash ?? null,
        failureReason: failureReasonOf(row),
        polled: true,
    });
}
async function refreshTouchBytes(touchId: number, row: RequestRow): Promise<void> {
    const bytes = renderedBytes(row);
    if (!bytes)
        return;
    await db().query(`UPDATE touch SET subject = $2, body = $3 WHERE id = $1`, [
        touchId,
        bytes.subject,
        bytes.text || (bytes.html ?? ''),
    ]);
}
async function createBridgeTouch(run: repo.MatchRunRow, row: RequestRow, now: Date): Promise<number | null> {
    const bytes = renderedBytes(row);
    if (!bytes) {
        log.warn('request is awaiting_approval but carries no rendered bytes — waiting', {
            requestId: row.request_id,
        });
        return null;
    }
    if (run.requested_by_prospect_id === null)
        return null;
    const { rows } = await db().query<{
        persona: string | null;
        engagement_type: string | null;
        detected_at: Date | null;
        seed_account_id: number | null;
    }>(`SELECT a.persona, e.engagement_type, e.detected_at, po.discovered_via_seed_id AS seed_account_id
       FROM prospect p
       LEFT JOIN LATERAL (
         SELECT persona FROM icp_assessment ia
          WHERE ia.prospect_id = p.id ORDER BY ia.created_at DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN engagement e ON e.prospect_id = p.id
       LEFT JOIN post po ON po.id = e.post_id
      WHERE p.id = $1
      ORDER BY (e.engagement_type = 'comment') DESC, e.detected_at DESC
      LIMIT 1`, [run.requested_by_prospect_id]);
    const context = rows[0];
    const detectedAt = context?.detected_at ?? null;
    const latencySeconds = detectedAt ? Math.max(0, Math.round((now.getTime() - detectedAt.getTime()) / 1000)) : null;
    const touch = await repo.insertTouch({
        prospectId: run.requested_by_prospect_id,
        channel: 'email',
        templateVersion: `bridge-claim@${run.campaign_key ?? campaignKeyFor()}`,
        angle: 'A1',
        persona: context?.persona ?? null,
        seedAccountId: context?.seed_account_id ?? null,
        signalType: context?.engagement_type ?? 'none',
        latencyBucket: latencySeconds === null ? null : latencyBucket(latencySeconds),
        latencyFromDetection: latencySeconds,
        matchRunId: run.id,
        noProof: false,
        subject: bytes.subject,
        body: bytes.text || (bytes.html ?? ''),
        hot: context?.engagement_type === 'comment',
        sequenceStep: 1,
        dryRun: config.dryRun,
    });
    return touch.id;
}
async function reopenForReapproval(touchId: number, reason: string): Promise<void> {
    await db().query(`UPDATE touch
        SET status = 'draft', approved_at = NULL, approved_by = NULL, content_hash = NULL
      WHERE id = $1 AND status IN ('approved', 'queued')`, [touchId]);
    await repo.insertAudit({
        touchId,
        actor: 'bridge',
        action: 'reclassify',
        beforeHash: null,
        afterHash: null,
        detail: { reason, note: 'the platform re-rendered this email; it needs approving again' },
    });
}
async function approvalPhase(client: BridgeClient, summary: BridgeSummary): Promise<void> {
    const pending = await repo.listMatchRunsAwaitingApprovalPush(config.bridge.pollLimit);
    for (const run of pending) {
        const outcome = await pushOneApproval(client, run, run.approved_by ?? config.dashboard.user);
        if (outcome.pushed)
            summary.approvalsPushed += 1;
        if (outcome.reRendered)
            summary.reRenders += 1;
    }
    const declined = await repo.listMatchRunsAwaitingSkipPush(config.bridge.pollLimit);
    for (const run of declined) {
        const result = await client.skip(run.bridge_row_uuid!, 'declined in the dashboard');
        if (result.ok) {
            await repo.updateMatchRun(run.id, { state: 'skipped', failureReason: 'declined in the dashboard' });
            continue;
        }
        if (result.status === 422) {
            await adoptPlatformState(client, run, `skip refused: ${result.reason ?? 'wrong_stage'}`);
        }
    }
}
async function adoptPlatformState(client: BridgeClient, run: repo.MatchRunRow, note: string): Promise<void> {
    const fresh = await client.getRequest(run.bridge_row_uuid!);
    if (!fresh.ok) {
        log.warn('the platform refused a call and then could not produce the request', {
            requestId: run.bridge_row_uuid,
            note,
        });
        return;
    }
    await mirrorRequestRow(run, fresh.row);
    log.info('adopted the platform state after a wrong-stage refusal', {
        requestId: run.bridge_row_uuid,
        status: fresh.row.status,
        note,
    });
}
export interface ApprovalPushOutcome {
    pushed: boolean;
    reRendered: boolean;
    note: string;
}
async function pushOneApproval(client: BridgeClient, run: repo.MatchRunRow, actor: string): Promise<ApprovalPushOutcome> {
    const result = await client.approve(run.bridge_row_uuid!, run.content_hash!, actor);
    if (result.ok) {
        await repo.updateMatchRun(run.id, { state: result.status });
        return { pushed: true, reRendered: false, note: 'sent to the platform to dispatch' };
    }
    if (result.kind === 'hash_mismatch') {
        const fresh = await client.getRequest(run.bridge_row_uuid!);
        if (fresh.ok) {
            await mirrorRequestRow(run, fresh.row);
            if (run.touch_id !== null)
                await refreshTouchBytes(run.touch_id, fresh.row);
        }
        if (run.touch_id !== null)
            await reopenForReapproval(run.touch_id, result.reason);
        return {
            pushed: false,
            reRendered: true,
            note: 'the numbers moved since this was written — the new wording is back in your queue for approval',
        };
    }
    await repo.updateMatchRun(run.id, { failureReason: result.reason });
    log.warn('approve refused by the platform', {
        requestId: run.bridge_row_uuid,
        status: result.status,
        code: result.code,
        reason: result.reason,
    });
    if (result.status === 422) {
        await adoptPlatformState(client, run, `approve refused: ${result.reason}`);
        return {
            pushed: false,
            reRendered: false,
            note: `the platform had already moved this on (${result.reason}) — nothing was sent twice`,
        };
    }
    return { pushed: false, reRendered: false, note: result.reason };
}
export async function pushApprovalForTouch(touchId: number, actor: string, deps: BridgeDeps = {}): Promise<ApprovalPushOutcome & {
    applicable: boolean;
}> {
    const run = await repo.matchRunForTouch(touchId);
    if (!run || !run.bridge_row_uuid) {
        return { applicable: false, pushed: false, reRendered: false, note: 'not a platform email' };
    }
    if (!run.content_hash) {
        return {
            applicable: true,
            pushed: false,
            reRendered: false,
            note: 'the platform has not finished rendering this email yet',
        };
    }
    const client = deps.client ?? BridgeClient.fromConfig();
    if (!client.available) {
        return {
            applicable: true,
            pushed: false,
            reRendered: false,
            note: `approved here; the platform will be told when the bridge is reachable (${client.unavailableReason})`,
        };
    }
    try {
        return { applicable: true, ...(await pushOneApproval(client, run, actor)) };
    }
    catch (err) {
        const message = err instanceof BridgeError ? err.message : (err as Error).message;
        await repo.openHold({
            subjectKind: 'match_run',
            subjectId: run.id,
            stage: 'bridge',
            reason: 'forwarding an approval to the platform failed',
            detail: { message, touchId },
        });
        return {
            applicable: true,
            pushed: false,
            reRendered: false,
            note: `approved here, but the platform could not be reached (${message}). It will be retried automatically.`,
        };
    }
}
export async function pushSkipForTouch(touchId: number, reason: string, deps: BridgeDeps = {}): Promise<{
    applicable: boolean;
    pushed: boolean;
    note: string;
}> {
    const run = await repo.matchRunForTouch(touchId);
    if (!run || !run.bridge_row_uuid) {
        return { applicable: false, pushed: false, note: 'not a platform email' };
    }
    const client = deps.client ?? BridgeClient.fromConfig();
    if (!client.available) {
        return {
            applicable: true,
            pushed: false,
            note: `skipped here; the platform still holds the request (${client.unavailableReason})`,
        };
    }
    try {
        const result = await client.skip(run.bridge_row_uuid, reason);
        if (result.ok) {
            await repo.updateMatchRun(run.id, { state: 'skipped', failureReason: reason });
            return { applicable: true, pushed: true, note: 'the platform will not send it' };
        }
        if (result.status === 422) {
            await adoptPlatformState(client, run, `skip refused: ${result.reason ?? 'wrong_stage'}`);
            return {
                applicable: true,
                pushed: false,
                note: `the platform had already moved this on (${result.reason ?? 'wrong_stage'}) — check its status`,
            };
        }
        return { applicable: true, pushed: false, note: `the platform returned ${result.status}` };
    }
    catch (err) {
        const message = err instanceof BridgeError ? err.message : (err as Error).message;
        return {
            applicable: true,
            pushed: false,
            note: `skipped here, but the platform could not be reached (${message})`,
        };
    }
}
const MAX_EVENT_PAGES = 20;
async function eventPhase(client: BridgeClient, summary: BridgeSummary): Promise<void> {
    const index = await buildTouchIndex();
    const byRequest = await repo.matchRunIndex();
    let cursor = await repo.getCursor('growth_bridge');
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const { events } = await client.fetchEvents(cursor, config.bridge.eventPageSize);
        if (events.length === 0) {
            log.debug('no new bridge events', { cursor, page });
            break;
        }
        const outcomes = bridgeEventsToOutcomes(events, (event: BridgeEvent) => {
            const hit = event.request_id ? byRequest.get(event.request_id) : undefined;
            return { touchId: hit?.touchId ?? null, prospectId: hit?.prospectId ?? null };
        });
        const plan = planOutcomeSync(outcomes, index, cursor);
        for (const event of plan.events) {
            const inserted = await repo.insertEvent(event);
            if (inserted) {
                summary.eventsRecorded += 1;
                await applyEventSideEffects(event);
            }
        }
        summary.unmatchedEvents += plan.unmatched;
        if (plan.newCursor > cursor) {
            cursor = plan.newCursor;
            await repo.advanceCursor('growth_bridge', cursor);
        }
        else {
            break;
        }
        if (events.length < config.bridge.eventPageSize)
            break;
    }
}
async function applyEventSideEffects(event: {
    kind: string;
    touchId: number | null;
    prospectId: number | null;
    payload: unknown;
}): Promise<void> {
    if (event.kind === 'rerender' && event.touchId !== null) {
        await reopenForReapproval(event.touchId, readString(event.payload, 'stage_reason') ??
            readString(event.payload, 'reason') ??
            'the platform re-rendered this email with new numbers');
    }
    if (event.kind === 'sent' && event.touchId !== null) {
        await repo.markTouchSent(event.touchId, {
            provider: 'growth_bridge',
            providerMessageId: null,
            providerThreadId: null,
            emailMessageId: readString(event.payload, 'message_id'),
            gmailThreadUrl: null,
            dryRun: false,
        });
    }
    if (event.kind === 'unsubscribed' && event.prospectId !== null) {
        const email = readString(event.payload, 'email');
        if (email) {
            await repo.addSuppression({
                prospectId: event.prospectId,
                alias: { kind: 'email', value: email },
                reason: 'unsubscribed via the platform',
                source: 'platform_export',
            });
        }
        await repo.pauseSequence(event.prospectId, 'unsubscribed');
    }
}
function readString(payload: unknown, key: string): string | null {
    if (!payload || typeof payload !== 'object')
        return null;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
async function buildTouchIndex(): Promise<SentTouchIndex> {
    const { rows } = await db().query<{
        id: number;
        prospect_id: number;
    }>(`SELECT id, prospect_id FROM touch`);
    const index: SentTouchIndex = {
        byMessageId: new Map(),
        byRecipient: new Map(),
        byLinkedInUrl: new Map(),
        prospectOf: new Map(),
    };
    for (const row of rows)
        index.prospectOf.set(row.id, row.prospect_id);
    return index;
}
