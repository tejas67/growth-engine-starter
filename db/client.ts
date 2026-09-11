import pg from 'pg';
import { config } from '../config/index.js';
let pool: pg.Pool | null = null;
export function db(): pg.Pool {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: config.database.url,
            max: config.database.poolMax,
            application_name: 'growth-engine-starter',
        });
        pool.on('error', (err) => {
            console.error('[db] idle client error', err);
        });
    }
    return pool;
}
export async function closeDb(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db().connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    }
    catch (err) {
        try {
            await client.query('ROLLBACK');
        }
        catch {
        }
        throw err;
    }
    finally {
        client.release();
    }
}
