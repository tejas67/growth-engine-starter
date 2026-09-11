import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexRunner } from '../src/clients/codex.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function stub(source: string, timeoutMs = 2000) {
    const dir = await mkdtemp(join(tmpdir(), 'codex-process-test-'));
    directories.push(dir);
    const binary = join(dir, 'codex');
    await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return codexRunner({ binary, model: 'test-model', reasoningEffort: 'medium', timeoutMs });
}
it('reads complete JSONL including a final line without a newline and stamps the model', async () => {
    const run = await stub(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(
    JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\\n'+
    JSON.stringify({type:'turn.completed'})));`);
    expect(await run('task', 'rules')).toBe('{"ok":true}');
    expect(run.lastGeneration).toEqual({ provider: 'codex', model: 'test-model' });
});
it.each([
    [{ type: 'turn.failed', error: { message: 'usage quota exhausted' } }, 'rate_limit'],
    [{ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }, 'transport'],
    [{ type: 'item.started', item: { type: 'command_execution' } }, 'transport'],
] as const)('fails closed on %j', async (row, kind) => {
    const run = await stub(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(row) + '\n')}));`);
    await expect(run('task', 'rules')).rejects.toMatchObject({ kind });
});
it('bounds a hung process', async () => {
    const run = await stub('process.stdin.resume(); setInterval(()=>{},1000);', 50);
    await expect(run('task', 'rules')).rejects.toMatchObject({ kind: 'timeout' });
});
