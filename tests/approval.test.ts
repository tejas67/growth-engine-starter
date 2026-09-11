import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, edit, skip, verifyApprovedBytes, type TouchState } from '../src/approval/state.js';
import { contentHash } from '../src/lib/hash.js';
const NOW = new Date('2026-08-15T12:00:00.000Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});
function draft(overrides: Partial<TouchState> = {}): TouchState {
    return {
        id: 501,
        status: 'draft',
        subject: null,
        body: 'Jordan, Orlando sim and training has more federal doors than any vertical I have mapped.',
        connectNote: null,
        templateVersion: 'A-hw@v2',
        founderEdited: false,
        contentHash: null,
        approvedAt: null,
        approvedBy: null,
        skippedAt: null,
        ...overrides,
    };
}
describe('double-tap approve is idempotent', () => {
    it('the first tap approves and stamps the immutable bytes', () => {
        const first = approve(draft(), 'owner', NOW);
        expect(first.changed).toBe(true);
        expect(first.touch.status).toBe('approved');
        expect(first.touch.approvedBy).toBe('owner');
        expect(first.touch.contentHash).toBe(contentHash(null, draft().body));
        expect(first.audit).not.toBeNull();
    });
    it('the second tap changes nothing and writes NO second audit row', () => {
        const first = approve(draft(), 'owner', NOW);
        const second = approve(first.touch, 'owner', new Date(NOW.getTime() + 4000));
        expect(second.changed).toBe(false);
        expect(second.audit).toBeNull();
        expect(second.note).toBe('already approved');
        expect(second.touch).toEqual(first.touch);
        expect(second.touch.approvedAt).toEqual(first.touch.approvedAt);
    });
    it('a hundred taps are indistinguishable from one', () => {
        let state = draft();
        let auditRows = 0;
        for (let i = 0; i < 100; i++) {
            const result = approve(state, 'owner', NOW);
            state = result.touch;
            if (result.audit)
                auditRows += 1;
        }
        expect(auditRows).toBe(1);
    });
    it('refuses to approve something already sent', () => {
        const result = approve(draft({ status: 'sent' }), 'owner', NOW);
        expect(result.changed).toBe(false);
        expect(result.note).toContain('cannot approve');
    });
});
describe('edit keeps template_version and sets founder_edited', () => {
    it('preserves the A/B cell across an edit', () => {
        const result = edit(draft(), { body: 'A completely rewritten message from the founder.' }, 'owner', NOW);
        expect(result.changed).toBe(true);
        expect(result.touch.templateVersion).toBe('A-hw@v2');
        expect(result.touch.founderEdited).toBe(true);
        expect(result.touch.body).toBe('A completely rewritten message from the founder.');
    });
    it('records the template_version on the audit row so the edit is reconstructable', () => {
        const result = edit(draft(), { body: 'new text entirely, rewritten' }, 'owner', NOW);
        expect(result.audit?.action).toBe('edit');
        expect(result.audit?.detail?.templateVersion).toBe('A-hw@v2');
        expect(result.audit?.beforeHash).not.toBe(result.audit?.afterHash);
    });
    it('un-approves an approved touch so the founder approves the NEW bytes', () => {
        const approved = approve(draft(), 'owner', NOW).touch;
        const edited = edit(approved, { body: 'second thoughts, rewritten entirely' }, 'owner', NOW);
        expect(edited.touch.status).toBe('draft');
        expect(edited.touch.contentHash).toBeNull();
        expect(edited.touch.approvedAt).toBeNull();
        expect(edited.note).toContain('re-approval required');
    });
    it('then approving stamps the NEW hash and still keeps template_version', () => {
        const approved = approve(draft(), 'owner', NOW).touch;
        const edited = edit(approved, { body: 'second thoughts, rewritten entirely' }, 'owner', NOW).touch;
        const reapproved = approve(edited, 'owner', NOW);
        expect(reapproved.touch.status).toBe('approved');
        expect(reapproved.touch.contentHash).toBe(contentHash(null, 'second thoughts, rewritten entirely'));
        expect(reapproved.touch.templateVersion).toBe('A-hw@v2');
        expect(reapproved.touch.founderEdited).toBe(true);
    });
    it('a no-op edit is a no-op', () => {
        const result = edit(draft(), { body: draft().body }, 'owner', NOW);
        expect(result.changed).toBe(false);
        expect(result.audit).toBeNull();
        expect(result.touch.founderEdited).toBe(false);
    });
});
describe('skip', () => {
    it('is idempotent too', () => {
        const first = skip(draft(), 'owner', NOW, 'not a fit');
        expect(first.changed).toBe(true);
        const second = skip(first.touch, 'owner', NOW);
        expect(second.changed).toBe(false);
        expect(second.audit).toBeNull();
    });
});
describe('send-time byte integrity', () => {
    it('accepts the exact approved bytes', () => {
        const approved = approve(draft(), 'owner', NOW).touch;
        expect(verifyApprovedBytes(approved, approved.subject, approved.body).ok).toBe(true);
    });
    it('REFUSES a re-render — the sender sends bytes, never a fresh render', () => {
        const approved = approve(draft(), 'owner', NOW).touch;
        const result = verifyApprovedBytes(approved, approved.subject, `${approved.body} `);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('refusing to send a re-render');
    });
    it('refuses an unapproved touch outright', () => {
        expect(verifyApprovedBytes(draft(), null, draft().body).ok).toBe(false);
    });
    it('refuses an approved touch that somehow carries no hash', () => {
        const result = verifyApprovedBytes(draft({ status: 'approved', contentHash: null }), null, draft().body);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('no content hash');
    });
});
