import { readSettings } from '../../config/local.js';
import { config } from '../../config/index.js';
import { recoverDraftHolds } from './draft_recovery.js';
import { db } from '../../db/client.js';
import { ApolloClient } from '../clients/apollo.js';
import { MillionVerifierClient } from '../clients/millionverifier.js';
import { HeyReachClient } from '../clients/heyreach.js';
import { ImapFlowReader } from '../clients/imap.js';
import { SerperProvider } from '../clients/search.js';
import type { ClaudeRunner } from '../clients/claude.js';
import { evaluateBounceTripwire, type EmailLaneMode } from '../guardrails/bounce_tripwire.js';
import { logger } from '../lib/log.js';
import { normalizeDomain } from '../lib/identity.js';
import { planHoldRelease, RETRYABLE_HOLD_REASONS } from './holds.js';
import * as repo from '../repo/index.js';
import { companyEvidenceFor, defaultDraftRunner, draftOne, loadCopywriter, type DraftCandidate } from './draft.js';
import { enrichOne, type EnrichTarget } from './enrich.js';
import { collectDmReplies, collectEmailReplies, gmailThreadUrl, type ReplyEventPlan, type SentTouchIndex, } from './ingest.js';
import { candidateHash, defaultRunner, loadRubric, preFilter, resolveAuthorCompany, scoreBatch, type ScoreCandidate, } from './score.js';
import { evaluateDispatchGates, dispatchOne, type DispatchTarget } from './send.js';
import { hostMatchesName, verifyCompany } from './verify_company.js';
const log = logger('stages');
interface ScoreRow {
    prospect_id: number;
    linkedin_url: string;
    full_name: string | null;
    headline: string | null;
    location: string | null;
    country_class: string;
    is_company_page: boolean;
    company_name: string | null;
    post_author_slug: string | null;
    post_author_name: string | null;
    post_excerpt: string | null;
    post_author_headline: string | null;
    engagement_type: 'like' | 'comment';
    comment_text: string | null;
}
async function releaseRetryableScoreHolds(): Promise<number> {
    const holds = await repo.listOpenHolds({
        stage: 'score',
        olderThanHours: config.score.holdRetryHours,
    });
    const plan = planHoldRelease(holds, { stage: 'score', reasons: [...RETRYABLE_HOLD_REASONS] });
    if (plan.holdIds.length === 0)
        return 0;
    const result = await repo.applyHoldRelease(plan, 'auto-retry');
    log.info('released retryable score holds', {
        holds: result.holdsResolved,
        prospects: result.prospectsRequeued,
        olderThanHours: config.score.holdRetryHours,
    });
    return result.prospectsRequeued;
}
export async function runScore(runner: ClaudeRunner = defaultRunner()): Promise<{
    scored: number;
    held: number;
    preFiltered: number;
    released: number;
}> {
    if (config.score.mode !== 'live')
        return { scored: 0, held: 0, preFiltered: 0, released: 0 };
    const released = await releaseRetryableScoreHolds();
    const pool = db();
    const { rows } = await pool.query<ScoreRow>(`SELECT DISTINCT ON (p.id)
            p.id AS prospect_id, p.linkedin_url, p.full_name, p.headline, p.location,
            p.country_class, p.is_company_page, p.company_name,
            po.author_slug AS post_author_slug, po.author_name AS post_author_name,
            po.author_headline AS post_author_headline,
            LEFT(COALESCE(po.content_text, p.source_note), 900) AS post_excerpt,
            COALESCE(e.engagement_type, 'none') AS engagement_type, e.comment_text
       FROM prospect p
       LEFT JOIN engagement e ON e.prospect_id = p.id
       LEFT JOIN post po ON po.id = e.post_id
      WHERE p.state = 'new' AND NOT p.is_demo AND p.canonical_prospect_id IS NULL
      -- Commenters first: they are the fast lane.
      ORDER BY p.id, (e.engagement_type = 'comment') DESC, e.detected_at DESC
      LIMIT $1`, [config.score.batchSize]);
    if (rows.length === 0)
        return { scored: 0, held: 0, preFiltered: 0, released };
    const seeds = await repo.listTrackedSeeds();
    const seedSlugs = new Set(seeds.map((s) => s.slug.trim().toLowerCase()));
    const seedCompanies = new Map(seeds
        .filter((s) => s.company_name)
        .map((s) => [s.slug.trim().toLowerCase(), s.company_name!] as const));
    const candidates: ScoreCandidate[] = rows.map((r) => ({
        prospectId: r.prospect_id,
        linkedinUrl: r.linkedin_url,
        fullName: r.full_name,
        headline: r.headline,
        location: r.location,
        countryClass: r.country_class,
        isCompanyPage: r.is_company_page,
        companyName: r.company_name,
        postAuthorSlug: r.post_author_slug,
        postAuthorName: r.post_author_name,
        postExcerpt: r.post_excerpt,
        engagementType: r.engagement_type,
        commentText: r.comment_text,
    }));
    const authorCompanies = new Map(rows.map((r) => [
        r.prospect_id,
        resolveAuthorCompany(r.post_author_slug, r.post_author_headline, seedCompanies),
    ] as const));
    const needModel: ScoreCandidate[] = [];
    let preFiltered = 0;
    for (const candidate of candidates) {
        const excluded = preFilter(candidate, {
            seedSlugs,
            authorSlug: candidate.postAuthorSlug,
            authorCompany: authorCompanies.get(candidate.prospectId) ?? null,
        });
        if (excluded) {
            await repo.insertAssessment({
                prospectId: candidate.prospectId,
                rubricVersion: config.score.rubricVersion,
                score: excluded.score,
                persona: excluded.persona,
                personaSubtype: excluded.persona_subtype ?? null,
                reasoning: excluded.reasoning,
                verificationRequired: false,
                stage: 'pre_enrich',
                model: 'deterministic',
                inputHash: candidateHash(candidate, config.score.rubricVersion),
            });
            await repo.setProspectState(candidate.prospectId, 'rejected', null);
            preFiltered += 1;
        }
        else
            needModel.push(candidate);
    }
    if (needModel.length === 0)
        return { scored: 0, held: 0, preFiltered, released };
    const rubric = await loadRubric();
    const outcome = await scoreBatch(needModel, rubric, runner);
    if (outcome.kind === 'hold') {
        for (const candidate of needModel) {
            await repo.setProspectState(candidate.prospectId, 'held', outcome.reason);
            await repo.openHold({
                subjectKind: 'prospect',
                subjectId: candidate.prospectId,
                stage: 'score',
                reason: outcome.reason,
                detail: { holdKind: outcome.holdKind, detail: outcome.detail },
            });
        }
        log.warn('score batch held', { reason: outcome.reason, size: needModel.length });
        return { scored: 0, held: needModel.length, preFiltered, released };
    }
    let scored = 0;
    let held = 0;
    for (const row of outcome.held) {
        await repo.setProspectState(row.candidate.prospectId, 'held', row.holdKind);
        await repo.openHold({
            subjectKind: 'prospect',
            subjectId: row.candidate.prospectId,
            stage: 'score',
            reason: row.holdKind,
            detail: { holdKind: row.holdKind, detail: row.detail },
        });
        held += 1;
    }
    for (const { candidate, assessment } of outcome.assessments) {
        await repo.insertAssessment({
            prospectId: candidate.prospectId,
            rubricVersion: config.score.rubricVersion,
            score: assessment.score,
            persona: assessment.persona,
            personaSubtype: assessment.persona_subtype ?? null,
            reasoning: assessment.reasoning,
            verificationRequired: assessment.verification_required,
            stage: 'pre_enrich',
            model: runner.lastGeneration ? `${runner.lastGeneration.provider}:${runner.lastGeneration.model}` : config.score.model,
            inputHash: candidateHash(candidate, config.score.rubricVersion),
        });
        if (assessment.hold) {
            await repo.setProspectState(candidate.prospectId, 'held', assessment.hold_reason ?? 'scorer held');
            await repo.openHold({
                subjectKind: 'prospect',
                subjectId: candidate.prospectId,
                stage: 'score',
                reason: 'scorer requested hold',
                detail: { reason: assessment.hold_reason },
            });
            held += 1;
            continue;
        }
        if (assessment.company_guess) {
            await db().query(`UPDATE prospect SET company_name = COALESCE(company_name, $2), is_gov = $3, updated_at = NOW() WHERE id = $1`, [candidate.prospectId, assessment.company_guess, assessment.gov_signal]);
        }
        await repo.setProspectState(candidate.prospectId, assessment.persona === 'P0' ? 'rejected' : 'scored', null);
        scored += 1;
    }
    return { scored, held, preFiltered, released };
}
export async function runVerify(provider = new SerperProvider()): Promise<{
    verified: number;
    inconclusive: number;
}> {
    const pool = db();
    const spent = await repo.unitsToday('serper');
    const remaining = Math.max(0, config.verify.dailyCap - spent);
    if (remaining === 0)
        return { verified: 0, inconclusive: 0 };
    const { rows } = await pool.query<{
        id: number;
        company_name: string | null;
        headline: string | null;
        full_name: string | null;
    }>(`SELECT p.id, p.company_name, p.headline, p.full_name
       FROM prospect p
       JOIN LATERAL (
         SELECT verification_required, persona FROM icp_assessment a
          WHERE a.prospect_id = p.id ORDER BY a.created_at DESC LIMIT 1
       ) a ON TRUE
      WHERE p.state = 'scored'
        AND NOT p.company_verified
        AND p.company_name IS NOT NULL
        -- A settled web verdict (inconclusive/contradicted) is recorded in the source
        -- column so the row is never re-queried; Apollo takes it from there.
        AND p.company_verification_source IS NULL
        AND a.persona <> 'P0'
      ORDER BY p.first_detected_at
      LIMIT $1`, [Math.min(remaining, 25)]);
    let verified = 0;
    let inconclusive = 0;
    for (const row of rows) {
        const asserted = /([a-z0-9-]+\.(?:io|com|ai|co|net|tech|us|dev))\b/i.exec(row.headline ?? '')?.[1] ?? null;
        const result = await verifyCompany({
            companyName: row.company_name!,
            personName: row.full_name,
            headline: row.headline,
            assertedDomain: asserted,
        }, provider);
        await pool.query(`INSERT INTO company_verification (prospect_id, query, provider, verdict, verified_domain, summary, evidence, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
            row.id,
            result.query,
            result.provider,
            result.verdict,
            result.verifiedDomain,
            result.summary,
            JSON.stringify(result.evidence),
            result.costUsd,
        ]);
        await repo.recordSpend('serper', result.costUsd, 1, { prospectId: row.id });
        if (result.verdict === 'verified') {
            await pool.query(`UPDATE prospect
            SET company_verified = TRUE, company_verified_at = NOW(),
                company_verification_source = $3,
                company_domain = COALESCE(company_domain, $2),
                state = 'verified', updated_at = NOW()
          WHERE id = $1`, [row.id, normalizeDomain(result.verifiedDomain), result.provider]);
            verified += 1;
        }
        else {
            await pool.query(`UPDATE prospect SET company_verification_source = $2, updated_at = NOW() WHERE id = $1`, [row.id, `serper:${result.verdict}`]);
            log.info('company unverified by web — falling through to apollo', {
                prospectId: row.id,
                verdict: result.verdict,
                summary: result.summary,
            });
            inconclusive += 1;
        }
    }
    return { verified, inconclusive };
}
async function verifyProspectEmail(prospectId: number, email: string, verifier: MillionVerifierClient): Promise<string | null> {
    const used = await repo.unitsToday('verify');
    if (used >= config.emailVerify.dailyCap) {
        log.info('email verification cap reached — addresses stay unverified today', { cap: config.emailVerify.dailyCap });
        return null;
    }
    const result = await verifier.verify(email);
    if (result.costUsd > 0 || result.effectiveMode === 'live') {
        await repo.recordSpend('verify', result.costUsd, 1, { prospectId, status: result.status });
    }
    if (result.status === 'unverified')
        return null;
    await db().query(`UPDATE prospect SET email_verify_status = $2, updated_at = NOW() WHERE id = $1`, [prospectId, result.status]);
    return result.status;
}
export async function runEnrich(apollo = new ApolloClient(), verifier = new MillionVerifierClient()): Promise<{
    attempted: number;
    matched: number;
    verified: number;
}> {
    const pool = db();
    const used = await repo.unitsToday('apollo');
    const remaining = Math.max(0, config.enrich.dailyCreditCap - used);
    if (remaining === 0)
        return { attempted: 0, matched: 0, verified: 0 };
    const { rows } = await pool.query<{
        id: number;
        linkedin_url: string;
        full_name: string | null;
        headline: string | null;
        company_name: string | null;
        company_domain: string | null;
        company_verified: boolean;
        email: string | null;
    }>(`SELECT p.id, p.linkedin_url, p.full_name, p.headline, p.company_name, p.company_domain,
            p.company_verified, p.email
       FROM prospect p
       JOIN LATERAL (
         SELECT persona FROM icp_assessment a
          WHERE a.prospect_id = p.id ORDER BY a.created_at DESC LIMIT 1
       ) a ON TRUE
      WHERE p.email IS NULL AND p.linkedin_url IS NOT NULL
        AND a.persona <> 'P0'
        AND (
          p.state = 'verified'
          -- Rows the web step can never settle: no company named at all, or a company
          -- the web check could not confirm. Apollo resolves the employer by LinkedIn URL.
          OR (p.state = 'scored'
              AND (p.company_name IS NULL
                   OR (NOT p.company_verified AND p.company_verification_source IS NOT NULL)))
        )
      ORDER BY p.first_detected_at
      LIMIT $1`, [Math.min(remaining, 25)]);
    let matched = 0;
    let verified = 0;
    for (const row of rows) {
        const target: EnrichTarget = {
            prospectId: row.id,
            linkedinUrl: row.linkedin_url,
            fullName: row.full_name,
            headline: row.headline,
            companyName: row.company_name,
            companyDomain: row.company_domain,
            companyVerified: row.company_verified,
            email: row.email,
        };
        try {
            const outcome = await enrichOne(target, apollo);
            await pool.query(`INSERT INTO enrichment (prospect_id, provider, matched, cost_usd, email, verify_status, firmographics)
         VALUES ($1,'apollo',$2,$3,$4,$5,$6)`, [
                row.id,
                outcome.matched,
                outcome.costUsd,
                outcome.patch.email,
                outcome.patch.emailVerifyStatus,
                outcome.firmographics ? JSON.stringify(outcome.firmographics) : null,
            ]);
            await repo.recordSpend('apollo', outcome.costUsd, 1, { prospectId: row.id });
            if (outcome.matched) {
                await pool.query(`UPDATE prospect
              SET email = COALESCE(email, $2),
                  email_verify_status = COALESCE(email_verify_status, $3),
                  company_name = COALESCE(company_name, $4),
                  company_domain = COALESCE(company_domain, $5),
                  is_gov = prospect.is_gov OR $6,
                  gov_reason = COALESCE(gov_reason, $7),
                  state = 'enriched', updated_at = NOW()
            WHERE id = $1`, [
                    row.id,
                    outcome.patch.email,
                    outcome.patch.emailVerifyStatus,
                    outcome.patch.companyName,
                    outcome.patch.companyDomain,
                    outcome.patch.isGov,
                    outcome.patch.govReason,
                ]);
                const apolloName = outcome.firmographics?.company_name;
                const apolloDomain = outcome.firmographics?.company_domain;
                if (!row.company_verified && typeof apolloDomain === 'string' && apolloDomain) {
                    const guess = row.company_name;
                    const agrees = !guess || hostMatchesName(apolloDomain, guess) ||
                        (typeof apolloName === 'string' && apolloName.trim().toLowerCase() === guess.trim().toLowerCase());
                    if (!agrees) {
                        log.warn('apollo employer replaces unverified company guess', {
                            prospectId: row.id,
                            guess,
                            apollo: apolloName ?? apolloDomain,
                        });
                    }
                    await pool.query(`UPDATE prospect
                SET company_name = COALESCE($2, company_name),
                    company_domain = $3,
                    company_verified = TRUE, company_verified_at = NOW(),
                    company_verification_source = 'apollo',
                    updated_at = NOW()
              WHERE id = $1 AND NOT company_verified`, [row.id, typeof apolloName === 'string' && apolloName.trim() ? apolloName.trim() : null, apolloDomain]);
                }
                if (outcome.patch.email) {
                    await repo.addAlias(row.id, { kind: 'email', value: outcome.patch.email }, 'apollo');
                    const status = await verifyProspectEmail(row.id, outcome.patch.email, verifier);
                    if (status !== null)
                        verified += 1;
                }
                matched += 1;
            }
            else {
                await repo.setProspectState(row.id, 'enriched', 'no Apollo match — DM-only (no_proof)');
            }
        }
        catch (err) {
            await repo.openHold({
                subjectKind: 'prospect',
                subjectId: row.id,
                stage: 'enrich',
                reason: 'apollo error',
                detail: { message: (err as Error).message },
            });
        }
    }
    return { attempted: rows.length, matched, verified };
}
export async function runDraft(runner: ClaudeRunner = defaultDraftRunner(), now = new Date(), prospectIds?: number[]): Promise<{
    drafted: number;
    rejected: number;
}> {
    if (config.draft.mode !== 'live' || config.draft.maxDraftsPerRun <= 0)
        return { drafted: 0, rejected: 0 };
    const recovered = await recoverDraftHolds();
    if (recovered)
        log.info('recovered transport-held drafts without rescoring', { prospects: recovered });
    const pool = db();
    const { rows } = await pool.query<{
        id: number;
        full_name: string | null;
        headline: string | null;
        location: string | null;
        company_name: string | null;
        company_domain: string | null;
        company_verified: boolean;
        email: string | null;
        is_gov: boolean;
        persona: string;
        score: number;
        state: string;
        signal_type: string;
        comment_text: string | null;
        post_topic: string | null;
        company_evidence: unknown;
        detected_at: Date;
        seed_account_id: number | null;
    }>(`SELECT * FROM (
     SELECT DISTINCT ON (p.id)
            p.id, p.full_name, p.headline, p.location, p.company_name, p.company_domain,
            p.company_verified, p.email, p.is_gov,
            a.persona, a.score, p.state,
            COALESCE(e.engagement_type, 'none') AS signal_type, e.comment_text, COALESCE(e.detected_at, p.first_detected_at) AS detected_at,
            LEFT(COALESCE(po.content_text, p.source_note), 600) AS post_topic,
            po.discovered_via_seed_id AS seed_account_id,
            (SELECT cv.evidence FROM company_verification cv
              WHERE cv.prospect_id=p.id AND cv.verdict='verified'
                AND cv.provider NOT LIKE '%dry_run%' AND cv.verified_domain=p.company_domain
              ORDER BY cv.created_at DESC LIMIT 1) AS company_evidence
       FROM prospect p
       JOIN LATERAL (
         SELECT persona, score FROM icp_assessment ia
          WHERE ia.prospect_id = p.id ORDER BY ia.created_at DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN engagement e ON e.prospect_id = p.id
       LEFT JOIN post po ON po.id = e.post_id
      -- 'scored' rows are admitted too: the DM lane needs no mailbox, and Apollo's 100/day
      -- cap must not gate a draft. P4 (government) never enters the automated DM queue —
      -- the plan routes them to the founder-touch list (audit 2026-09-08: 556 of them,
      -- mostly engagers of Space Force / DoW / DIU page posts).
      WHERE NOT p.is_demo AND p.state IN ('verified','enriched','scored')
        AND ($2::integer[] IS NULL OR p.id=ANY($2))
        AND p.canonical_prospect_id IS NULL
        AND p.sequence_paused_at IS NULL
        AND a.persona NOT IN ('P0','P4')
        AND NOT p.is_gov
        AND NOT EXISTS (SELECT 1 FROM touch t WHERE t.prospect_id = p.id AND t.status <> 'skipped')
      ORDER BY p.id, (e.engagement_type = 'comment') DESC, e.detected_at DESC
     ) q
     -- Best first: commenters, then the higher ICP score, then rows already enriched.
     ORDER BY (q.signal_type IN ('comment','multi')) DESC, q.score DESC, (q.state = 'scored') ASC, q.id
     LIMIT $1`, [config.draft.maxDraftsPerRun, prospectIds ?? null]);
    if (rows.length === 0)
        return { drafted: 0, rejected: 0 };
    const copywriter = await loadCopywriter();
    let drafted = 0;
    let rejected = 0;
    for (const row of rows) {
        const channel: DraftCandidate['channel'] = 'dm';
        const candidate: DraftCandidate = {
            prospectId: row.id,
            channel,
            fullName: row.full_name,
            firstName: row.full_name?.split(' ')[0] ?? null,
            headline: row.headline,
            location: row.location,
            companyName: row.company_name,
            companyDomain: row.company_domain,
            companyVerified: row.company_verified,
            companyEvidence: companyEvidenceFor(row.company_domain, row.company_evidence),
            persona: row.persona as DraftCandidate['persona'],
            score: row.score,
            email: row.email,
            isGov: row.is_gov,
            signalType: row.signal_type as DraftCandidate['signalType'],
            commentText: row.comment_text,
            postTopic: row.post_topic,
            detectedAt: row.detected_at,
            seedAccountId: row.seed_account_id,
            matchProof: null,
        };
        const result = await draftOne(candidate, copywriter, runner, now);
        if (result.kind === 'rejected') {
            if (result.rejection.kind === 'hold' && result.rejection.providerUnavailable) {
                log.warn('draft provider unavailable; remaining prospects stay queued', { detail: result.rejection.detail });
                break;
            }
            rejected += 1;
            await repo.openHold({
                subjectKind: 'prospect',
                subjectId: row.id,
                stage: 'draft',
                reason: result.rejection.kind,
                detail: result.rejection,
            });
            if (result.rejection.kind !== 'gate') {
                await repo.setProspectState(row.id, 'held', result.rejection.reason);
            }
            continue;
        }
        await repo.insertTouch({
            prospectId: row.id,
            channel,
            templateVersion: result.templateVersion,
            generationProvider: result.generation?.provider ?? null,
            generationModel: result.generation?.model ?? null,
            angle: result.output.angle,
            persona: row.persona,
            seedAccountId: row.seed_account_id,
            signalType: row.signal_type,
            latencyBucket: result.latencyBucket,
            latencyFromDetection: result.latencySeconds,
            matchRunId: null,
            noProof: result.noProof,
            subject: result.output.subject,
            body: result.output.body,
            connectNote: result.output.connect_note,
            hot: result.hot,
            sequenceStep: 1,
            dryRun: config.dryRun,
        });
        await repo.setProspectState(row.id, 'drafted', null);
        drafted += 1;
    }
    return { drafted, rejected };
}
export async function runSend(heyreach = new HeyReachClient(), now = new Date()): Promise<{
    dispatched: number;
    refused: number;
}> {
    const pool = db();
    if (config.dryRun || !config.send.dmEnabled)
        return { dispatched: 0, refused: 0 };
    const settingsSnapshot = JSON.stringify(readSettings());
    const keySnapshot = config.send.heyreachKey;
    const identity = await heyreach.senderIdentity();
    if (!identity.connected || identity.restricted)
        return { dispatched: 0, refused: 0 };
    const approved = await repo.listApprovedTouches(50);
    if (approved.length === 0)
        return { dispatched: 0, refused: 0 };
    const laneMode = (await repo.getLaneState<{
        mode: EmailLaneMode;
    }>('email_lane_restriction', {
        mode: 'all',
    })).mode;
    const kill = await repo.getLaneState<{
        sending_enabled?: boolean;
        sendingEnabled?: boolean;
    }>('kill_switch', {});
    const sendingEnabled = Boolean(kill.sending_enabled ?? kill.sendingEnabled ?? false);
    const { rows: todayRows } = await pool.query<{
        channel: string;
        count: string;
    }>(`SELECT channel, COUNT(*) AS count FROM touch
      WHERE COALESCE(enrolled_at,sent_at)::DATE = (NOW() AT TIME ZONE 'UTC')::DATE AND NOT dry_run
      GROUP BY channel`);
    const sentToday = {
        dms: Number(todayRows.find((r) => r.channel === 'dm')?.count ?? 0),
        connects: Number(todayRows.find((r) => r.channel === 'connect')?.count ?? 0),
        emails: Number(todayRows.find((r) => r.channel === 'email')?.count ?? 0),
    };
    let dispatched = 0;
    let refused = 0;
    for (const touch of approved) {
        if (settingsSnapshot !== JSON.stringify(readSettings()) || keySnapshot !== config.send.heyreachKey)
            break;
        const { rows: pRows } = await pool.query<{
            linkedin_url: string | null;
            email: string | null;
            email_verify_status: string | null;
            company_name: string | null;
            headline: string | null;
            full_name: string | null;
            is_demo: boolean;
        }>(`SELECT is_demo, linkedin_url, email, email_verify_status, company_name, headline, full_name
         FROM prospect WHERE id = $1`, [touch.prospect_id]);
        const p = pRows[0];
        if (!p)
            continue;
        const suppression = await repo.isSuppressedOrPaused(touch.prospect_id);
        const prospectTouches = (await repo.touchesForProspect(touch.prospect_id)).map((t) => ({
            id: t.id,
            prospectId: t.prospect_id,
            channel: t.channel,
            sentAt: t.sent_at,
            status: t.status,
        }));
        const target: DispatchTarget = {
            touch: {
                id: touch.id,
                status: 'approved',
                subject: touch.subject,
                body: touch.body,
                connectNote: touch.connect_note,
                templateVersion: touch.template_version,
                founderEdited: touch.founder_edited,
                contentHash: touch.content_hash,
                approvedAt: touch.approved_at,
                approvedBy: null,
                skippedAt: null,
            },
            isDemo: p.is_demo,
            channel: touch.channel,
            prospectId: touch.prospect_id,
            linkedinUrl: p.linkedin_url,
            fullName: p.full_name ?? null,
            email: p.email,
            emailVerifyStatus: p.email_verify_status,
            companyName: p.company_name,
            headline: p.headline,
            persona: touch.persona,
        };
        const currentKill = await repo.getLaneState<{
            sending_enabled?: boolean;
        }>('kill_switch', {});
        const context = { now, suppression, prospectTouches, sendingEnabled: currentKill.sending_enabled === true,
            emailLaneMode: laneMode, sentToday, rampStartDate: config.send.ramp.startDate || null };
        const gate = evaluateDispatchGates(target, context);
        if (!gate.allowed) {
            refused++;
            continue;
        }
        const claim = await pool.query(`INSERT INTO dispatch_attempt(touch_id,status)
      SELECT id,'pending' FROM touch WHERE id=$1 AND status='approved' AND content_hash=$2
      ON CONFLICT DO NOTHING RETURNING touch_id`, [touch.id, touch.content_hash]);
        if (!claim.rowCount)
            continue;
        try {
            const outcome = await dispatchOne(target, context, heyreach);
            if (outcome.dispatched) {
                await pool.query("UPDATE dispatch_attempt SET status='accepted',detail='Lead accepted by HeyReach; delivery not yet confirmed',updated_at=NOW() WHERE touch_id=$1", [touch.id]);
                await pool.query("UPDATE touch SET status='queued',enrolled_at=NOW(),provider='heyreach',provider_message_id=$2,provider_thread_id=$3,dry_run=FALSE WHERE id=$1", [touch.id, outcome.providerMessageId, outcome.providerThreadId]);
                if (touch.channel === 'connect')
                    sentToday.connects++;
                else
                    sentToday.dms++;
                dispatched++;
            }
            else {
                await pool.query("UPDATE dispatch_attempt SET status='refused',detail=$2,updated_at=NOW() WHERE touch_id=$1", [touch.id, outcome.reason]);
                refused++;
            }
        }
        catch {
            await pool.query("UPDATE dispatch_attempt SET status='uncertain',detail='Check the lead in HeyReach before retrying. The request may have been accepted.',updated_at=NOW() WHERE touch_id=$1", [touch.id]);
            refused++;
        }
    }
    return { dispatched, refused };
}
async function buildSentIndex(): Promise<SentTouchIndex> {
    const { rows } = await db().query<{
        id: number;
        prospect_id: number;
        email_message_id: string | null;
        email: string | null;
        linkedin_url: string | null;
        sent_at: Date | null;
    }>(`SELECT t.id, t.prospect_id, t.email_message_id, p.email, p.linkedin_url, t.sent_at
       FROM touch t JOIN prospect p ON p.id = t.prospect_id
      WHERE t.sent_at IS NOT NULL
      ORDER BY t.sent_at DESC`);
    const index: SentTouchIndex = {
        byMessageId: new Map(),
        byRecipient: new Map(),
        byLinkedInUrl: new Map(),
        prospectOf: new Map(),
    };
    for (const r of rows) {
        index.prospectOf.set(r.id, r.prospect_id);
        if (r.email_message_id)
            index.byMessageId.set(r.email_message_id, r.id);
        if (r.email) {
            const key = r.email.toLowerCase();
            if (!index.byRecipient.has(key))
                index.byRecipient.set(key, []);
            index.byRecipient.get(key)!.push(r.id);
        }
        if (r.linkedin_url) {
            const key = r.linkedin_url.toLowerCase();
            if (!index.byLinkedInUrl.has(key))
                index.byLinkedInUrl.set(key, []);
            index.byLinkedInUrl.get(key)!.push(r.id);
        }
    }
    return index;
}
async function applyReplyPlans(plans: ReplyEventPlan[]): Promise<number> {
    let recorded = 0;
    for (const plan of plans) {
        const inserted = await repo.insertEvent({
            eventKey: plan.eventKey,
            touchId: plan.touchId,
            prospectId: plan.prospectId,
            kind: plan.kind,
            channel: plan.channel,
            source: plan.source,
            payload: plan.payload,
            occurredAt: plan.occurredAt,
        });
        if (!inserted)
            continue;
        recorded += 1;
        if (plan.pauseProspectId !== null) {
            await repo.pauseSequence(plan.pauseProspectId, `reply received on ${plan.channel}`);
        }
    }
    return recorded;
}
export async function runIngest(deps: {
    imap?: ImapFlowReader;
    heyreach?: HeyReachClient;
} = {}, now = new Date()): Promise<{
    emailReplies: number;
    dmReplies: number;
    bounceTripwireTripped: boolean;
}> {
    const index = await buildSentIndex();
    const since = new Date(now.getTime() - config.ingest.lookbackDays * 86400000);
    const imap = deps.imap ?? new ImapFlowReader();
    const heyreach = deps.heyreach ?? new HeyReachClient();
    let emailReplies = 0;
    try {
        emailReplies = await applyReplyPlans(await collectEmailReplies(imap, since, index));
    }
    catch (err) {
        await repo.openHold({
            subjectKind: 'lane',
            subjectId: null,
            stage: 'ingest',
            reason: 'IMAP poll failed — reply detection degraded to manual triage',
            detail: { message: (err as Error).message },
        });
    }
    let dmReplies = 0;
    try {
        dmReplies = await applyReplyPlans(await collectDmReplies(heyreach, since, index));
    }
    catch (err) {
        await repo.openHold({
            subjectKind: 'lane',
            subjectId: null,
            stage: 'ingest',
            reason: 'HeyReach reply sync failed',
            detail: { message: (err as Error).message },
        });
    }
    const tripped = await evaluateAndApplyTripwire(now);
    return { emailReplies, dmReplies, bounceTripwireTripped: tripped };
}
export async function evaluateAndApplyTripwire(now = new Date()): Promise<boolean> {
    const { rows } = await db().query<{
        id: number;
        sent_at: Date;
        bounced_at: Date | null;
    }>(`SELECT t.id, t.sent_at,
            (SELECT MIN(e.occurred_at) FROM event e
              WHERE e.touch_id = t.id AND e.kind = 'hard_bounced') AS bounced_at
       FROM touch t
      WHERE t.channel = 'email' AND t.sent_at IS NOT NULL AND NOT t.dry_run
      ORDER BY t.sent_at DESC
      LIMIT $1`, [config.guardrails.bounceTripwireWindow]);
    const state = evaluateBounceTripwire(rows.map((r) => ({ touchId: r.id, sentAt: r.sent_at, hardBouncedAt: r.bounced_at })), now);
    const current = await repo.getLaneState<{
        mode: EmailLaneMode;
    }>('email_lane_restriction', {
        mode: 'all',
    });
    const desired: EmailLaneMode = state.tripped ? 'good_only' : current.mode;
    if (desired !== current.mode) {
        await repo.setLaneState('email_lane_restriction', { mode: desired, tripped_at: now.toISOString(), reason: state.reason }, 'tripwire');
        log.warn('bounce tripwire tripped', { reason: state.reason });
    }
    return state.tripped;
}
export { runBridge, type BridgeSummary } from './bridge_stage.js';
export async function runPrune(): Promise<{
    pruned: number;
}> {
    const pruned = await repo.pruneRawCommentText(config.guardrails.rawTextRetentionDays);
    return { pruned };
}
export function threadUrlFor(threadId: string | null, messageId: string | null): string {
    return gmailThreadUrl(config.ingest.gmailDeepLinkBase, threadId, messageId);
}
