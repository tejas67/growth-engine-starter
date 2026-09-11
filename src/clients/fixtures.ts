import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../../config/index.js';
const ROOT = resolve(process.cwd());
export function fixturePath(key: string, captured = false): string {
    const base = join(ROOT, config.scrape.fixturesDir, captured ? 'captured' : '');
    return join(base, `${key}.json`);
}
export async function readFixture<T>(key: string): Promise<T | null> {
    for (const candidate of [fixturePath(key, true), fixturePath(key, false)]) {
        try {
            return JSON.parse(await readFile(candidate, 'utf8')) as T;
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
                throw err;
        }
    }
    return null;
}
export async function writeFixture(key: string, value: unknown): Promise<string> {
    const path = fixturePath(key, true);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return path;
}
export function fixtureKey(...parts: Array<string | number>): string {
    return parts
        .map((p) => String(p).replace(/[^a-zA-Z0-9._-]+/g, '_'))
        .join('__')
        .slice(0, 120);
}
