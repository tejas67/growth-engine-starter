import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { businessContext, projectRoot } from '../../config/local.js';
import { config } from '../../config/index.js';
import { asQuotedData, callStructured, ClaudeError, type ClaudeRunner, type GenerationInfo } from '../clients/claude.js';
import { liveDraftRunner } from '../clients/draft_runner.js';
import { lintDraft, type LintViolation } from '../copy/lint.js';
import { coldEmailAllowed } from '../guardrails/gov_gate.js';
import { latencyBucket, type LatencyBucket } from '../lib/time.js';
import { logger } from '../lib/log.js';
const log = logger('draft');
const SKILL_PATH = join(projectRoot, 'skills/copywriter.md');
export const SHAPES = ['A-hw', 'B-intro'] as const;
export type Shape = (typeof SHAPES)[number];
export const ANGLES = ['A1', 'A2', 'A3', 'A4'] as const;
export const DraftSchema = z.object({
    subject: z.string().nullable(),
    body: z.string().min(20),
    connect_note: z.string().min(10).max(300),
    shape: z.enum(SHAPES),
    angle: z.enum(ANGLES),
    rationale: z.string().min(1),
});
export type DraftOutput = z.infer<typeof DraftSchema>;
export const DraftDecisionSchema = z.union([
    z.object({ decision: z.literal('hold'), reason: z.string().min(10) }),
    DraftSchema,
]);
export interface CompanyEvidence {
    title: string;
    link: string;
    snippet: string;
}
export function companyEvidenceFor(domain: string | null, evidence: unknown): CompanyEvidence[] {
    if (!domain || !Array.isArray(evidence))
        return [];
    const host = domain.toLowerCase().replace(/^www\./, '');
    return evidence.filter((hit): hit is CompanyEvidence => {
        if (!hit || typeof hit.title !== 'string' || typeof hit.snippet !== 'string' || typeof hit.link !== 'string')
            return false;
        try {
            const url = new URL(hit.link);
            const found = url.hostname.toLowerCase().replace(/^www\./, '');
            return url.protocol === 'https:' && (found === host || found.endsWith(`.${host}`));
        }
        catch {
            return false;
        }
    }).slice(0, 3).map(hit => ({ title: hit.title.slice(0, 200), link: hit.link, snippet: hit.snippet.slice(0, 900) }));
}
export interface MatchProof {
    matchCount: number;
    potentialTotalUsd: number | null;
    agencies: string[];
    highlights: string[];
    producedAt: Date;
}
export interface DraftCandidate {
    prospectId: number;
    channel: 'email' | 'dm' | 'connect';
    fullName: string | null;
    firstName: string | null;
    headline: string | null;
    location: string | null;
    companyName: string | null;
    companyDomain: string | null;
    companyVerified: boolean;
    companyEvidence?: CompanyEvidence[];
    persona: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
    score: number;
    email: string | null;
    isGov: boolean;
    signalType: 'like' | 'comment' | 'repost' | 'multi' | 'none';
    commentText: string | null;
    postTopic: string | null;
    detectedAt: Date;
    seedAccountId: number | null;
    matchProof: MatchProof | null;
}
export type DraftRejection = {
    kind: 'gate';
    reason: string;
} | {
    kind: 'lint';
    reason: string;
    violations: LintViolation[];
} | {
    kind: 'hold';
    reason: string;
    detail: string;
    providerUnavailable?: boolean;
};
export type DraftResult = {
    kind: 'drafted';
    generation: GenerationInfo | null;
    output: DraftOutput;
    templateVersion: string;
    latencyBucket: LatencyBucket;
    latencySeconds: number;
    noProof: boolean;
    hot: boolean;
    lintWarnings: LintViolation[];
} | {
    kind: 'rejected';
    rejection: DraftRejection;
};
export function preDraftGate(candidate: DraftCandidate): {
    ok: boolean;
    reason: string;
} {
    if (candidate.persona === 'P0') {
        return { ok: false, reason: 'P0 — logged, never contacted' };
    }
    if (candidate.channel === 'email') {
        if (!candidate.companyVerified) {
            return {
                ok: false,
                reason: 'company not verified — no product-proof email ships without company verification (rubric v0.3)',
            };
        }
        const gov = coldEmailAllowed({
            email: candidate.email,
            employer: candidate.companyName,
            headline: candidate.headline,
            persona: candidate.persona,
        });
        if (!gov.allowed)
            return { ok: false, reason: gov.reason };
        if (!candidate.email)
            return { ok: false, reason: 'no mailbox — DM-only lane (F4 no_proof)' };
        if (!candidate.matchProof || candidate.matchProof.matchCount < 1) {
            return {
                ok: false,
                reason: 'no live match proof — routing to DM-only rather than sending count-free product-proof copy (F4)',
            };
        }
    }
    return { ok: true, reason: 'clear' };
}
export function assignShape(prospectId: number): Shape {
    return SHAPES[prospectId % SHAPES.length]!;
}
export function buildDraftPrompt(candidate: DraftCandidate, shape: Shape): string {
    const parts: string[] = [
        `Decide whether the supplied facts support useful outreach. If they do, write ONE ${candidate.channel} message and connect_note. Otherwise return decision: hold with the missing context.`,
        businessContext(),
        `Shape: ${shape}`,
        `Persona: ${candidate.persona}`,
        `Their first name: ${candidate.firstName ?? candidate.fullName ?? '(unknown — use no name)'}`,
        candidate.companyVerified && candidate.companyName
            ? `Their company: ${candidate.companyName}${candidate.companyDomain ? ` (${candidate.companyDomain})` : ''}`
            : 'Their company: UNKNOWN — do NOT name, guess or allude to any company. ' +
                'Only use supported facts about their work. Do not use location or the post topic as a substitute for relevance.',
    ];
    parts.push(asQuotedData('their_headline', candidate.headline));
    parts.push(asQuotedData('their_location', candidate.location));
    const evidence = candidate.companyVerified
        ? companyEvidenceFor(candidate.companyDomain, candidate.companyEvidence) : [];
    if (evidence.length) {
        parts.push(asQuotedData('company_site_search_excerpts', JSON.stringify(evidence)));
        parts.push('These are search excerpts from the verified company domain. They describe its work; they are not evidence of buying intent.');
    }
    if (candidate.postTopic)
        parts.push(asQuotedData('conversation_topic', candidate.postTopic));
    if (candidate.commentText) {
        parts.push(asQuotedData('their_point_in_the_conversation', candidate.commentText));
        parts.push('Their comment can establish a relevant need. It was not addressed to the sender. Do not pretend it was a conversation with them or quote it verbatim.');
    }
    if (candidate.matchProof && candidate.matchProof.matchCount > 0) {
        const p = candidate.matchProof;
        parts.push(asQuotedData('real_match_numbers_produced_by_our_platform', [
            `programs that fit: ${p.matchCount}`,
            p.potentialTotalUsd ? `published dollar figures total: $${p.potentialTotalUsd}` : '',
            p.agencies.length ? `agencies: ${p.agencies.join(', ')}` : '',
            p.highlights.length ? `examples: ${p.highlights.join(' | ')}` : '',
        ]
            .filter(Boolean)
            .join('\n')));
        parts.push('These numbers ARE real and were produced for this company. Lead with them.');
    }
    else {
        parts.push('No recipient-specific research deliverable has been supplied. Use only the offer and evidence in BUSINESS CONFIGURATION, if their work makes that useful. ' +
            'Do not imply completed research, an existing list, named matches, guaranteed matches, or confirmed buyer demand. ' +
            'Do not substitute questions about their process or requests for advice. If the offer has no supported relevance, hold.');
    }
    if (candidate.channel === 'connect') {
        parts.push('HARD LIMIT: 300 characters including spaces.');
    }
    return parts.join('\n');
}
export async function loadCopywriter(path = SKILL_PATH): Promise<string> {
    return readFile(path, 'utf8');
}
export async function draftOne(candidate: DraftCandidate, copywriter: string, runner: ClaudeRunner, now: Date, maxLintRetries = 2): Promise<DraftResult> {
    const gate = preDraftGate(candidate);
    if (!gate.ok)
        return { kind: 'rejected', rejection: { kind: 'gate', reason: gate.reason } };
    const shape = assignShape(candidate.prospectId);
    const basePrompt = buildDraftPrompt(candidate, shape);
    const scraped = [candidate.headline, candidate.commentText, candidate.postTopic].filter((s): s is string => Boolean(s));
    scraped.push(...(candidate.companyEvidence ?? []).map(hit => hit.snippet));
    let lastViolations: LintViolation[] = [];
    let lastBody = '';
    for (let attempt = 0; attempt <= maxLintRetries; attempt++) {
        const prompt = attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nYour previous draft was REJECTED by the doctrine lint:\n` +
                lastViolations.map((v) => `- ${v.rule}: ${v.detail}`).join('\n') +
                `\n\nThe rejected draft, so you can see exactly where the problem is:\n<rejected_draft>\n${lastBody}\n</rejected_draft>\n` +
                `\nRewrite it. Same shape, same facts. Remove every flagged string entirely (do not paraphrase a banned phrase into a near-synonym of itself), ` +
                `and never reuse more than five consecutive words from any text inside the context tags.`;
        let output: DraftOutput;
        try {
            const call = await callStructured(runner, DraftDecisionSchema, prompt, copywriter, config.draft.maxRetries);
            if ('decision' in call.value) {
                return { kind: 'rejected', rejection: { kind: 'hold', reason: 'no_relevant_offer', detail: call.value.reason } };
            }
            output = call.value;
        }
        catch (err) {
            const detail = err instanceof ClaudeError ? `${err.kind}: ${err.message}` : (err as Error).message;
            const providerUnavailable = err instanceof ClaudeError && ['transport', 'timeout', 'rate_limit'].includes(err.kind);
            return { kind: 'rejected', rejection: { kind: 'hold', reason: 'llm', detail, providerUnavailable } };
        }
        const forbiddenNames = !candidate.companyVerified && candidate.companyName ? [candidate.companyName] : [];
        const hasMatchProof = Boolean(candidate.matchProof && candidate.matchProof.matchCount > 0);
        const bodyLint = lintDraft(output.body, { scrapedText: scraped, channel: candidate.channel, forbiddenNames, hasMatchProof });
        const noteLint = lintDraft(output.connect_note, { scrapedText: scraped, channel: 'connect', forbiddenNames, hasMatchProof });
        const lint = {
            ok: bodyLint.ok && noteLint.ok,
            violations: [
                ...bodyLint.violations,
                ...noteLint.violations.map((v) => ({ ...v, rule: `note:${v.rule}`, detail: `connection note: ${v.detail}` })),
            ],
        };
        if (lint.ok) {
            const latencySeconds = Math.max(0, Math.round((now.getTime() - candidate.detectedAt.getTime()) / 1000));
            return {
                kind: 'drafted',
                generation: runner.lastGeneration ? { ...runner.lastGeneration } : null,
                output: { ...output, shape },
                templateVersion: `${shape}@${config.draft.copywriterVersion}`,
                latencyBucket: latencyBucket(latencySeconds),
                latencySeconds,
                noProof: !candidate.matchProof || candidate.matchProof.matchCount === 0,
                hot: candidate.signalType === 'comment' || candidate.signalType === 'multi',
                lintWarnings: lint.violations.filter((v) => v.severity === 'warn'),
            };
        }
        lastViolations = lint.violations.filter((v) => v.severity === 'error');
        lastBody = output.body;
        log.warn('draft failed doctrine lint', {
            prospectId: candidate.prospectId,
            attempt,
            rules: lastViolations.map((v) => v.rule),
        });
    }
    return {
        kind: 'rejected',
        rejection: {
            kind: 'lint',
            reason: `draft failed the doctrine lint after ${maxLintRetries + 1} attempts`,
            violations: lastViolations,
        },
    };
}
export function dryRunDraftRunner(): ClaudeRunner {
    return async (prompt: string) => {
        const shape: Shape = prompt.includes('Shape: B-intro') ? 'B-intro' : 'A-hw';
        const name = /Their first name: (.+)/.exec(prompt)?.[1]?.split('(')[0]?.trim() ?? 'there';
        const company = /Their company: ([^(\n]+)/.exec(prompt)?.[1]?.trim() ?? 'your company';
        const body = shape === 'A-hw'
            ? `${name}, the federal programs that fit a company like ${company} mostly move through ` +
                `channels that never surface in a public search. That is the part I keep running into. ` +
                `How does ${company} hear about that work today, early or late?`
            : `Hi ${name} — Owner here. I run Growth Engine, a small software team; the Navy is our first ` +
                `customer. We map federal programs to the companies and the people that fit them. ` +
                `I came across ${company} and wanted to say hello. How has the federal side been going?`;
        return JSON.stringify({
            subject: null,
            body,
            shape,
            angle: 'A1',
            rationale: 'DRY RUN — no model was called. Placeholder copy to exercise the queue.',
        });
    };
}
export function defaultDraftRunner(): ClaudeRunner {
    if (config.draft.mode !== 'live')
        return dryRunDraftRunner();
    return liveDraftRunner();
}
export function refSlug(touchId: number): string {
    return `li-t${touchId}`;
}
export function signupLink(touchId: number, base = 'https://app.example.invalid'): string {
    return `${base}/signup?ref=${refSlug(touchId)}`;
}
