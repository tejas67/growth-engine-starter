import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, closeDb } from './client.js';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
export interface MigrationFile {
    name: string;
    sql: string;
    checksum: string;
}
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const out: MigrationFile[] = [];
    for (const name of entries) {
        const sql = await readFile(join(dir, name), 'utf8');
        out.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    }
    return out;
}
async function ensureLedger(): Promise<void> {
    await db().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
export async function status(): Promise<void> {
    await ensureLedger();
    const files = await loadMigrations();
    const { rows } = await db().query<{
        name: string;
        checksum: string;
    }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
        const got = applied.get(f.name);
        if (!got)
            console.log(`pending  ${f.name}`);
        else if (got !== f.checksum)
            console.log(`DRIFTED  ${f.name}  (checksum mismatch)`);
        else
            console.log(`applied  ${f.name}`);
    }
}
export async function up(): Promise<void> {
    await ensureLedger();
    const files = await loadMigrations();
    const { rows } = await db().query<{
        name: string;
        checksum: string;
    }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
        const seen = applied.get(f.name);
        if (seen === f.checksum)
            continue;
        if (seen && seen !== f.checksum) {
            throw new Error(`migration ${f.name} was modified after it was applied (checksum drift). ` +
                `Never edit an applied migration — add a new one.`);
        }
        const client = await db().connect();
        try {
            await client.query('BEGIN');
            await client.query(f.sql);
            await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
                f.name,
                f.checksum,
            ]);
            await client.query('COMMIT');
            console.log(`applied  ${f.name}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw new Error(`migration ${f.name} failed: ${(err as Error).message}`);
        }
        finally {
            client.release();
        }
    }
    console.log('migrations up to date');
}
const isMain = process.argv[1] && process.argv[1].endsWith('migrate.ts');
if (isMain) {
    const cmd = process.argv[2] ?? 'up';
    const run = cmd === 'status' ? status : up;
    run()
        .then(() => closeDb())
        .catch(async (err) => {
        console.error(err.message);
        await closeDb();
        process.exit(1);
    });
}
