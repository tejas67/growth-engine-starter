import { describe, it, expect, vi } from 'vitest';
import { parseCliResult, ClaudeError, type ClaudeRunner } from '../src/clients/claude.js';
import { withDraftFallback, type ProviderCooldown, type CooldownStore } from '../src/clients/draft_runner.js';
import { codexArgs, codexEnvironment } from '../src/clients/codex.js';
import { draftOne, type DraftCandidate } from '../src/pipeline/draft.js';
function memory(): CooldownStore {
    const state = new Map<string, ProviderCooldown>();
    return { get: async (k) => state.get(k) ?? null, set: async (k, v) => { state.set(k, v); } };
}
const candidate: DraftCandidate = { prospectId: 3, channel: 'dm', fullName: 'Jo Smith', firstName: 'Jo',
    headline: 'Founder', location: null, companyName: null, companyDomain: null, companyVerified: false,
    persona: 'P1', score: 70, email: null, isGov: false, signalType: 'like', commentText: null,
    postTopic: null, detectedAt: new Date(), seedAccountId: null, matchProof: null };
describe('Claude process failures', () => {
    it('recognizes the observed stdout-only Primary exhaustion message', () => {
        try {
            parseCliResult(JSON.stringify({ is_error: true, result: "You've reached your Primary limit. Switch to another model to continue." }), '', 1);
        }
        catch (err) {
            expect(err).toBeInstanceOf(ClaudeError);
            expect((err as ClaudeError).kind).toBe('rate_limit');
            return;
        }
        throw new Error('expected usage limit');
    });
    it('rejects malformed envelopes through the promise, rather than crashing the worker', () => {
        expect(() => parseCliResult('{', '', 0)).toThrow('envelope unparseable');
    });
});
describe('draft failover', () => {
    it('persists exhaustion across runner instances and retries primary after cooldown', async () => {
        const primary = vi.fn().mockRejectedValueOnce(new ClaudeError('Primary limit', 'rate_limit')).mockResolvedValue('primary');
        const backup = vi.fn().mockResolvedValue('backup');
        const store = memory();
        let now = new Date('2026-09-09T10:00:00Z');
        const opts = { key: 'test', cooldownMs: 3600000, store, now: () => now };
        expect(await withDraftFallback(primary, backup, opts)('p', 's')).toBe('backup');
        expect(await withDraftFallback(primary, backup, opts)('p', 's')).toBe('backup');
        expect(primary).toHaveBeenCalledTimes(1);
        now = new Date('2026-09-09T11:01:00Z');
        expect(await withDraftFallback(primary, backup, opts)('p', 's')).toBe('primary');
    });
    it.each(['refusal', 'malformed', 'transport', 'timeout'] as const)('does not switch on %s', async (kind) => {
        const backup = vi.fn();
        const run = withDraftFallback(async () => { throw new ClaudeError('failure', kind); }, backup, { key: 'test', cooldownMs: 100, store: memory() });
        await expect(run('p', 's')).rejects.toThrow('failure');
        expect(backup).not.toHaveBeenCalled();
    });
    it('keeps fallback output behind the same lint and records the actual model', async () => {
        let calls = 0;
        const backup: ClaudeRunner = async () => {
            calls++;
            backup.lastGeneration = { provider: 'codex', model: 'gpt-6-astra' };
            return JSON.stringify({ subject: null, body: calls === 1 ? 'Hey Jo — quick question.' : 'Jo, I built Growth Engine to help companies find federal opportunities. How are you finding programs to pursue?',
                connect_note: 'Jo, Owner here. I built Growth Engine and would like to connect.', shape: 'B-intro', angle: 'A1', rationale: 'Plain introduction.' });
        };
        const run = withDraftFallback(async () => { throw new ClaudeError('limit', 'rate_limit'); }, backup, { key: 'test', cooldownMs: 10000, store: memory() });
        const result = await draftOne(candidate, 'Return JSON.', run, new Date());
        expect(calls).toBe(2);
        expect(result.kind).toBe('drafted');
        if (result.kind === 'drafted')
            expect(result.generation).toEqual({ provider: 'codex', model: 'gpt-6-astra' });
    });
    it('leaves provider outages retryable rather than treating the lead as rejected', async () => {
        const result = await draftOne(candidate, '', async () => { throw new ClaudeError('quota', 'rate_limit'); }, new Date());
        expect(result).toMatchObject({ kind: 'rejected', rejection: { kind: 'hold', providerUnavailable: true } });
    });
});
it('isolates Codex from worker secrets, tools, plugins, and project configuration', () => {
    expect(codexEnvironment({ PATH: '/bin', HOME: '/home/node', APOLLO_API_KEY: 'secret', GROWTH_DATABASE_URL: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret' }))
        .toEqual({ PATH: '/bin', HOME: '/home/node' });
    const args = codexArgs({ binary: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', timeoutMs: 1000 }, '/tmp/draft');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args.join(' ')).toContain('--disable shell_tool');
    expect(args).toContain('web_search="disabled"');
});
