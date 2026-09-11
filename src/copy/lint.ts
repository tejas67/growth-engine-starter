import { readSettings } from '../../config/local.js';
export interface LintViolation {
    rule: string;
    detail: string;
    severity: 'error' | 'warn';
}
export interface LintResult {
    ok: boolean;
    violations: LintViolation[];
}
export const BANNED_PHRASES: string[] = [
    'exactly the kind of company',
    'hat question:',
    'happy to show you',
    'worth a look',
    'curious',
    'circle back',
    'quick question',
    'reach out',
    'touch base',
    'i hope this finds you well',
    'game changer',
    'excited to share',
    'no strings attached',
    'let me know if',
    'does that resonate',
    'the whole game',
    'whole ballgame',
    'the whole thing',
    'you asked',
    'you told me',
    'you mentioned to me',
    'read up on',
    'i looked into',
    'dug into',
    'compare notes',
    'i came across',
    'keeps showing up',
    'keep running into',
    'i want to understand better',
    'want to understand better',
];
const DASH_PATTERN = /[\u2014\u2013]/;
const CONTRAST_PATTERNS: RegExp[] = [
    /,\s*not\s+[^,.;!?\n]{1,60}[.;!?]/i,
    /\bnot\s+[^,.;!?\n]{1,60},\s*but\b/i,
    /\bnot\s+(?:just|only|merely|simply)\s+[^,.;!?\n]{1,50}\bbut\b/i,
];
const ATTRIBUTED_SPEECH_WARN = /\byou(?:'ve| have)?\s+(?:said|wrote|pointed out|raised|noted|argued)\b/i;
const WATCHING_PATTERNS: RegExp[] = [
    /\bsaw (you|your) (comment|like|post|react)/i,
    /\bnoticed (you|your) (comment|like|engagement|activity)/i,
    /\byou (liked|commented on|reacted to)\b/i,
    /\bon linkedin\b/i,
    /\byour recent (activity|engagement)\b/i,
    /\bcame across your (comment|like)\b/i,
];
const TRIPLET_PATTERNS: RegExp[] = [
    /\breal [a-z]+, real [a-z]+, no [a-z]+/i,
    /\bno [a-z]+, no [a-z]+, no [a-z]+/i,
    /\b([a-z]+ing), \1?[a-z]*ing, and [a-z]+ing\b/i,
];
const NAVY_PARTNER_PATTERNS: RegExp[] = [
    /\bnavy\b[^.!?]{0,40}\bpartner/i,
    /\bpartner(ed|ship|s)?\b[^.!?]{0,40}\bnavy\b/i,
    /\bpartnered with the (navy|nswc|navsea)\b/i,
    /\bin partnership with the navy\b/i,
];
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
export interface LintContext {
    scrapedText?: string[];
    allowedUrlPrefixes?: string[];
    channel?: 'email' | 'dm' | 'connect';
    forbiddenNames?: string[];
    hasMatchProof?: boolean;
}
function normalize(text: string): string {
    return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}
function longestSharedRun(draft: string, scraped: string): number {
    const draftWords = normalize(draft).split(' ').filter(Boolean);
    const scrapedWords = new Set<string>();
    const scrapedTokens = normalize(scraped).split(' ').filter(Boolean);
    for (let i = 0; i < scrapedTokens.length; i++) {
        for (let len = 6; len <= 12 && i + len <= scrapedTokens.length; len++) {
            scrapedWords.add(scrapedTokens.slice(i, i + len).join(' '));
        }
    }
    let longest = 0;
    for (let i = 0; i < draftWords.length; i++) {
        for (let len = 6; len <= 12 && i + len <= draftWords.length; len++) {
            if (scrapedWords.has(draftWords.slice(i, i + len).join(' ')))
                longest = Math.max(longest, len);
        }
    }
    return longest;
}
export function lintDraft(body: string, ctx: LintContext = {}): LintResult {
    const violations: LintViolation[] = [];
    const text = normalize(body);
    const inventedInterest = /\b(?:learn (?:more )?about your work|(?:value|love|appreciate|welcome) (?:your|a) (?:criticism|take|perspective|insight|view|advice)|(?:would|i'd) (?:like|love) to hear (?:how|what)|(?:made me|i was) wonder(?:ing)?|pick your brain)\b/i;
    if (inventedInterest.test(text)) {
        violations.push({ rule: 'invented_interest', detail: 'replaces a useful offer with ungrounded interest or a request for advice', severity: 'error' });
    }
    if (ctx.hasMatchProof === false && /\b(?:i|we)(?:'ve| have)?\s+(?:found|identified|ran|mapped|pulled together|put together|prepared)\b|\b(?:have|got)\s+(?:a|the|your)\s+(?:shortlist|list|report)\b/i.test(text)) {
        violations.push({ rule: 'unsupported_match_work', detail: 'claims completed research or an existing deliverable without company match evidence; offer to check instead', severity: 'error' });
    }
    for (const name of ctx.forbiddenNames ?? []) {
        const needle = normalize(name).trim();
        if (needle.length >= 3 && text.includes(needle)) {
            violations.push({
                rule: 'unverified_company_named',
                detail: `names "${name}", a company we could not verify — write to the person and the topic, not the employer`,
                severity: 'error',
            });
        }
    }
    for (const phrase of [...BANNED_PHRASES, ...readSettings().business.bannedPhrases].map(normalize)) {
        if (text.includes(phrase)) {
            violations.push({
                rule: 'banned_phrase',
                detail: `contains banned phrase "${phrase}"`,
                severity: 'error',
            });
        }
    }
    if (DASH_PATTERN.test(body)) {
        violations.push({
            rule: 'dash',
            detail: 'contains an em or en dash — use a comma, a full stop or a hyphen',
            severity: 'error',
        });
    }
    for (const pattern of CONTRAST_PATTERNS) {
        const m = pattern.exec(body);
        if (m) {
            violations.push({
                rule: 'contrast_framing',
                detail: `"${m[0].trim()}" — no "X, not Y" / "not X but Y" framing; say the thing and stop`,
                severity: 'error',
            });
            break;
        }
    }
    if (ATTRIBUTED_SPEECH_WARN.test(body)) {
        violations.push({
            rule: 'attributed_speech',
            detail: 'claims they said something — their comment was to the room, not to the sender; take up the idea, not the act',
            severity: 'warn',
        });
    }
    for (const pattern of WATCHING_PATTERNS) {
        if (pattern.test(body)) {
            violations.push({
                rule: 'empathy_rule',
                detail: `references the act of watching (${pattern.source}) — engagement decides timing, never the pitch`,
                severity: 'error',
            });
        }
    }
    for (const pattern of TRIPLET_PATTERNS) {
        if (pattern.test(body)) {
            violations.push({ rule: 'triplet_slogan', detail: 'triplet slogan construction', severity: 'error' });
        }
    }
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    const colonHook = /^[^:\n]{3,40}:\s+\S/.exec(firstLine.trim());
    if (colonHook && !/^https?/i.test(firstLine.trim())) {
        violations.push({
            rule: 'colon_hook_opener',
            detail: `opens with a colon hook: "${firstLine.trim().slice(0, 48)}"`,
            severity: 'error',
        });
    }
    const urlMatch = URL_PATTERN.exec(body);
    if (urlMatch) {
        const allowed = (ctx.allowedUrlPrefixes ?? []).some((p) => urlMatch[0].startsWith(p));
        if (!allowed) {
            violations.push({
                rule: 'unapproved_url',
                detail: `contains a URL not on the allow-list: ${urlMatch[0]}`,
                severity: 'error',
            });
        }
    }
    for (const scraped of ctx.scrapedText ?? []) {
        if (!scraped || scraped.length < 40)
            continue;
        const run = longestSharedRun(body, scraped);
        if (run >= 6) {
            violations.push({
                rule: 'scraped_verbatim',
                detail: `${run}-word run lifted verbatim from scraped content — prompt injection surface`,
                severity: 'error',
            });
            break;
        }
    }
    if (ctx.channel === 'dm' && body.length > 700) {
        violations.push({
            rule: 'dm_length',
            detail: `${body.length} chars — DMs stay short; long ones read as pitch-stuffing`,
            severity: 'warn',
        });
    }
    if (ctx.channel === 'connect' && body.length > 300) {
        violations.push({
            rule: 'connect_note_length',
            detail: `${body.length} chars — LinkedIn connection notes are capped at 300`,
            severity: 'error',
        });
    }
    return { ok: violations.every((v) => v.severity !== 'error'), violations };
}
