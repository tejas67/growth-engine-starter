import { config } from '../../config/index.js';
import { db } from '../../db/client.js';
import { logger } from '../lib/log.js';
import { ClaudeError, cliRunner, type ClaudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
export interface ProviderCooldown {
    until: string;
    reason: string;
}
export interface CooldownStore {
    get(key: string): Promise<ProviderCooldown | null>;
    set(key: string, value: ProviderCooldown): Promise<void>;
}
const persisted: CooldownStore = {
    async get(key) {
        const { rows } = await db().query('SELECT value FROM lane_state WHERE key=$1', [key]);
        return rows[0]?.value ?? null;
    },
    async set(key, value) {
        await db().query(`INSERT INTO lane_state (key,value,updated_by) VALUES ($1,$2,'draft-runner')
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW(),updated_by=EXCLUDED.updated_by`, [key, JSON.stringify(value)]);
    },
};
export function withDraftFallback(primary: ClaudeRunner, fallback: ClaudeRunner, opts: {
    key: string;
    cooldownMs: number;
    store: CooldownStore;
    now?: () => Date;
}): ClaudeRunner {
    const now = opts.now ?? (() => new Date());
    const runner: ClaudeRunner = async (prompt, system) => {
        const cooldown = await opts.store.get(opts.key);
        if (!cooldown || new Date(cooldown.until).getTime() <= now().getTime()) {
            try {
                const value = await primary(prompt, system);
                runner.lastGeneration = primary.lastGeneration;
                return value;
            }
            catch (err) {
                if (!(err instanceof ClaudeError) || err.kind !== 'rate_limit')
                    throw err;
                await opts.store.set(opts.key, { until: new Date(now().getTime() + opts.cooldownMs).toISOString(), reason: err.message });
                logger('draft-provider').warn('primary usage limit reached; using Codex', { model: config.draft.model });
            }
        }
        const value = await fallback(prompt, system);
        runner.lastGeneration = fallback.lastGeneration;
        return value;
    };
    return runner;
}
export { liveAiRunner as liveDraftRunner } from './ai.js';
