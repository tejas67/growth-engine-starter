import { contentHash } from '../lib/hash.js';
export type TouchStatus = 'draft' | 'approved' | 'skipped' | 'queued' | 'sent' | 'failed' | 'paused' | 'suppressed';
export interface TouchState {
    id: number;
    status: TouchStatus;
    subject: string | null;
    body: string;
    connectNote: string | null;
    templateVersion: string;
    founderEdited: boolean;
    contentHash: string | null;
    approvedAt: Date | null;
    approvedBy: string | null;
    skippedAt: Date | null;
}
export interface AuditEntry {
    touchId: number;
    actor: string;
    action: 'approve' | 'edit' | 'skip' | 'unskip' | 'reclassify';
    beforeHash: string | null;
    afterHash: string | null;
    detail?: Record<string, unknown>;
    at: Date;
}
export interface TransitionResult {
    touch: TouchState;
    audit: AuditEntry | null;
    changed: boolean;
    note: string;
}
const TERMINAL: TouchStatus[] = ['sent', 'suppressed'];
export function approve(touch: TouchState, actor: string, now: Date): TransitionResult {
    if (touch.status === 'approved') {
        return { touch, audit: null, changed: false, note: 'already approved' };
    }
    if (TERMINAL.includes(touch.status)) {
        return { touch, audit: null, changed: false, note: `cannot approve a ${touch.status} touch` };
    }
    const hash = contentHash(touch.subject, touch.body, touch.connectNote);
    const next: TouchState = {
        ...touch,
        status: 'approved',
        contentHash: hash,
        approvedAt: now,
        approvedBy: actor,
    };
    return {
        touch: next,
        audit: {
            touchId: touch.id,
            actor,
            action: 'approve',
            beforeHash: touch.contentHash,
            afterHash: hash,
            at: now,
        },
        changed: true,
        note: 'approved',
    };
}
export interface EditInput {
    subject?: string | null;
    body?: string;
    connectNote?: string | null;
}
export function edit(touch: TouchState, input: EditInput, actor: string, now: Date): TransitionResult {
    if (TERMINAL.includes(touch.status)) {
        return { touch, audit: null, changed: false, note: `cannot edit a ${touch.status} touch` };
    }
    const nextSubject = input.subject === undefined ? touch.subject : input.subject;
    const nextBody = input.body === undefined ? touch.body : input.body;
    const nextNote = input.connectNote === undefined ? touch.connectNote : input.connectNote;
    if (nextSubject === touch.subject && nextBody === touch.body && nextNote === touch.connectNote) {
        return { touch, audit: null, changed: false, note: 'no textual change' };
    }
    const before = touch.contentHash ?? contentHash(touch.subject, touch.body, touch.connectNote);
    const after = contentHash(nextSubject, nextBody, nextNote);
    const next: TouchState = {
        ...touch,
        subject: nextSubject,
        body: nextBody,
        connectNote: nextNote,
        templateVersion: touch.templateVersion,
        founderEdited: true,
        status: touch.status === 'approved' ? 'draft' : touch.status,
        contentHash: null,
        approvedAt: touch.status === 'approved' ? null : touch.approvedAt,
        approvedBy: touch.status === 'approved' ? null : touch.approvedBy,
    };
    return {
        touch: next,
        audit: {
            touchId: touch.id,
            actor,
            action: 'edit',
            beforeHash: before,
            afterHash: after,
            detail: { templateVersion: touch.templateVersion, reApprovalRequired: touch.status === 'approved' },
            at: now,
        },
        changed: true,
        note: touch.status === 'approved' ? 'edited — re-approval required' : 'edited',
    };
}
export function skip(touch: TouchState, actor: string, now: Date, reason?: string): TransitionResult {
    if (touch.status === 'skipped') {
        return { touch, audit: null, changed: false, note: 'already skipped' };
    }
    if (TERMINAL.includes(touch.status)) {
        return { touch, audit: null, changed: false, note: `cannot skip a ${touch.status} touch` };
    }
    const next: TouchState = { ...touch, status: 'skipped', skippedAt: now };
    return {
        touch: next,
        audit: {
            touchId: touch.id,
            actor,
            action: 'skip',
            beforeHash: touch.contentHash,
            afterHash: null,
            detail: reason ? { reason } : undefined,
            at: now,
        },
        changed: true,
        note: 'skipped',
    };
}
export function verifyApprovedBytes(touch: TouchState, subject: string | null, body: string, connectNote: string | null = touch.connectNote): {
    ok: boolean;
    reason: string;
} {
    if (touch.status !== 'approved') {
        return { ok: false, reason: `touch is ${touch.status}, not approved` };
    }
    if (!touch.contentHash) {
        return { ok: false, reason: 'approved touch carries no content hash' };
    }
    const actual = contentHash(subject, body, connectNote);
    if (actual !== touch.contentHash) {
        return {
            ok: false,
            reason: 'content hash mismatch — the bytes changed after approval; refusing to send a re-render',
        };
    }
    return { ok: true, reason: 'approved bytes intact' };
}
