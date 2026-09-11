const GOV_EMAIL_SUFFIXES = ['.gov', '.mil'];
const GOV_EMPLOYER_PATTERNS: RegExp[] = [
    /\b(dod|department of defense)\b/i,
    /\bu\.?s\.? (army|navy|air force|space force|marine corps|coast guard)\b/i,
    /\b(navsea|navair|nswc|spawar|navwar|afrl|arl|onr|darpa|diu|sample-agency-two|socom|ussocom|ussf)\b/i,
    /\b(federal|government) (agency|office)\b/i,
    /\bdepartment of (energy|homeland security|state|veterans affairs|commerce)\b/i,
    /\b(nasa|nist|nsf|gsa|dhs|dia|nga|nro|nsa|cia|fbi)\b/i,
    /\bprogram (executive )?office\b/i,
    /\bpeo\b/,
    /\bcontracting officer\b/i,
];
const GOV_TITLE_PATTERNS: RegExp[] = [
    /\bdeputy (chief|director)\b/i,
    /\bfederal (cio|cto|ciso)\b/i,
    /\b(gs-1[0-5]|sess?|senior executive service)\b/i,
    /\bacquisitions? officer\b/i,
    /\bsmall business (specialist|advocate|professional)\b/i,
];
export interface GovSignal {
    email?: string | null;
    employer?: string | null;
    headline?: string | null;
    title?: string | null;
    persona?: string | null;
}
export interface GovVerdict {
    isGov: boolean;
    ambiguous: boolean;
    reason: string;
}
export function assessGov(signal: GovSignal): GovVerdict {
    const email = signal.email?.trim().toLowerCase() ?? '';
    if (email) {
        const domain = email.split('@')[1] ?? '';
        for (const suffix of GOV_EMAIL_SUFFIXES) {
            if (domain === suffix.slice(1) || domain.endsWith(suffix)) {
                return { isGov: true, ambiguous: false, reason: `mailbox on ${suffix} domain` };
            }
        }
    }
    if (signal.persona === 'P4') {
        return { isGov: true, ambiguous: false, reason: 'scored persona P4 (government staff)' };
    }
    const haystack = [signal.employer, signal.headline, signal.title].filter(Boolean).join(' ');
    for (const pattern of GOV_EMPLOYER_PATTERNS) {
        if (pattern.test(haystack)) {
            return { isGov: true, ambiguous: false, reason: `gov employer signal: ${pattern.source}` };
        }
    }
    for (const pattern of GOV_TITLE_PATTERNS) {
        if (pattern.test(haystack)) {
            return { isGov: true, ambiguous: true, reason: `gov-shaped title: ${pattern.source}` };
        }
    }
    if (!email && !haystack) {
        return { isGov: false, ambiguous: true, reason: 'no employer, title or mailbox to judge' };
    }
    return { isGov: false, ambiguous: false, reason: 'no government signal' };
}
export function coldEmailAllowed(signal: GovSignal): {
    allowed: boolean;
    reason: string;
} {
    const verdict = assessGov(signal);
    if (verdict.isGov) {
        return { allowed: false, reason: `gov gate: ${verdict.reason} — founder-touch list only` };
    }
    if (verdict.ambiguous) {
        return { allowed: false, reason: `gov gate ambiguous (${verdict.reason}) — fails closed` };
    }
    return { allowed: true, reason: verdict.reason };
}
