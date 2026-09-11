import { withTx } from '../../db/client.js';
import { config } from '../../config/index.js';
import { budgetFor, jitterMs, type UnipileCallKind, type UnipileCallLedger, type UnipileError } from './unipile.js';
export function cooldownUntil(error: UnipileError, now: Date): Date {
    const base = error.status === 429
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
        : now.getTime() + 60 * 60000;
    return new Date(Math.max(base, now.getTime() + (error.retryAfterMs ?? 0)));
}
export function productionUnipileLedger(onRecord: (kind: UnipileCallKind) => Promise<void>): UnipileCallLedger {
    const account = config.unipile.accountId;
    const key = `unipile-account:${account}`;
    return {
        async admit(kind) {
            if (budgetFor(kind) === null)
                return { ok: true };
            return withTx(async (client) => {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
                const { rows } = await client.query<{
                    value: {
                        until?: string;
                        reason?: string;
                        next_call_at?: string;
                    };
                }>('SELECT value FROM lane_state WHERE key=$1', [key]);
                const state = rows[0]?.value ?? {};
                const now = new Date();
                if (state.until && new Date(state.until).getTime() > now.getTime()) {
                    return { ok: false, reason: `${state.reason}; next check ${state.until}` };
                }
                const category = budgetFor(kind) === 'profiles' ? 'unipile_profile' : 'unipile';
                const { rows: usage } = await client.query<{
                    total: string;
                    action: string;
                }>(`
          SELECT COALESCE(SUM(units),0) AS total,
            COALESCE(SUM(units) FILTER (WHERE meta->>'kind'=$3),0) AS action
          FROM spend_ledger WHERE day=(NOW() AT TIME ZONE 'UTC')::date AND category=$1
            AND COALESCE(meta->>'account_id',$2)=$2`, [category, account, kind]);
                const cap = category === 'unipile_profile' ? config.unipile.dailyProfileCap : config.unipile.dailyCallCap;
                if (Number(usage[0]?.total) >= cap || Number(usage[0]?.action) >= config.unipile.dailyActionCap) {
                    return { ok: false, reason: `daily ${category}/${kind} call cap reached — resumes next UTC day` };
                }
                const slot = Math.max(now.getTime(), new Date(state.next_call_at ?? 0).getTime());
                const next = new Date(slot + jitterMs(config.unipile.minDelayMs, config.unipile.maxDelayMs));
                await client.query(`INSERT INTO spend_ledger(day,category,amount_usd,units,meta)
          VALUES ((NOW() AT TIME ZONE 'UTC')::date,$1,0,1,$2)`, [category, JSON.stringify({ kind, account_id: account })]);
                await client.query(`INSERT INTO lane_state(key,value,updated_by) VALUES ($1,$2,'unipile')
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [key, JSON.stringify({ ...state, next_call_at: next.toISOString() })]);
                return { ok: true, waitMs: slot - now.getTime() };
            });
        },
        record: onRecord,
        async block(error) {
            await withTx(async (client) => {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
                const { rows } = await client.query('SELECT value FROM lane_state WHERE key=$1', [key]);
                const state = rows[0]?.value ?? {};
                const until = cooldownUntil(error, new Date());
                if (state.until && new Date(state.until).getTime() >= until.getTime())
                    return;
                const value = { ...state, until: until.toISOString(), reason: `Unipile HTTP ${error.status}` };
                await client.query(`INSERT INTO lane_state(key,value,updated_by) VALUES ($1,$2,'unipile')
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [key, JSON.stringify(value)]);
            });
        },
    };
}
