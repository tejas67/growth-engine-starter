import { db } from '../../db/client.js';
import { logger } from './log.js';
const log = logger('stage-lock');
export interface LockSkipped {
    skipped: true;
    reason: string;
}
export async function withStageLock<T>(stage: string, fn: () => Promise<T>): Promise<T | LockSkipped> {
    const client = await db().connect();
    try {
        const { rows } = await client.query<{
            ok: boolean;
        }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`growth:stage:${stage}`]);
        if (!rows[0]?.ok) {
            log.warn('stage already running elsewhere — skipping this run', { stage });
            return { skipped: true, reason: `another ${stage} run holds the stage lock` };
        }
        try {
            return await fn();
        }
        finally {
            await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`growth:stage:${stage}`]);
        }
    }
    finally {
        client.release();
    }
}
