import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeError, type ClaudeRunner } from './claude.js';
export interface CodexOptions {
    binary: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
}
export function codexArgs(opts: CodexOptions, cwd: string): string[] {
    return ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
        '-C', cwd, '-s', 'read-only', '--disable', 'shell_tool', '--disable', 'apps',
        '--disable', 'plugins', '--disable', 'browser_use', '--disable', 'computer_use',
        '--disable', 'image_generation', '--disable', 'multi_agent',
        '-c', 'web_search="disabled"', '-c', `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`,
        ...(opts.model ? ['-m', opts.model] : []), '--json', '-'];
}
export function codexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE']
        .flatMap(k => env[k] === undefined ? [] : [[k, env[k]!]]));
}
export function codexRunner(opts: CodexOptions): ClaudeRunner {
    const runner: ClaudeRunner = async (prompt, system) => {
        const cwd = await mkdtemp(join(tmpdir(), 'growth-draft-'));
        try {
            const result = await new Promise<string>((resolve, reject) => {
                const child = spawn(opts.binary, codexArgs(opts, cwd), {
                    stdio: ['pipe', 'pipe', 'pipe'], env: codexEnvironment(process.env),
                });
                let pending = '', stderr = '', answer = '', failure = '';
                let completed = false;
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    reject(new ClaudeError(`codex timed out after ${opts.timeoutMs}ms`, 'timeout'));
                }, opts.timeoutMs);
                const event = (line: string) => {
                    if (!line.trim())
                        return;
                    let row: {
                        type?: string;
                        item?: {
                            type?: string;
                            text?: string;
                        };
                        error?: {
                            message?: string;
                        };
                        message?: string;
                    };
                    try {
                        row = JSON.parse(line);
                    }
                    catch {
                        failure = 'invalid JSONL from codex';
                        return;
                    }
                    if (row.type === 'turn.completed')
                        completed = true;
                    if (row.type === 'turn.failed' || row.type === 'error')
                        failure = row.error?.message ?? row.message ?? 'codex turn failed';
                    if (row.type === 'item.completed' && row.item?.type === 'agent_message')
                        answer = row.item.text ?? '';
                    if (row.type?.startsWith('item.') && row.item?.type &&
                        !['agent_message', 'reasoning', 'error'].includes(row.item.type)) {
                        failure = `unexpected tool capability in text-only drafter: ${row.item.type}`;
                        child.kill('SIGKILL');
                    }
                };
                child.stdout.on('data', d => {
                    pending += String(d);
                    if (pending.length > 2000000) {
                        failure = 'Model output exceeds size limit';
                        child.kill('SIGKILL');
                        return;
                    }
                    let at: number;
                    while ((at = pending.indexOf('\n')) >= 0) {
                        event(pending.slice(0, at));
                        pending = pending.slice(at + 1);
                    }
                });
                child.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-1000); });
                child.on('error', err => { clearTimeout(timer); reject(new ClaudeError(`codex spawn failed: ${err.message}`, 'transport')); });
                child.stdin.on('error', () => { });
                child.on('close', code => {
                    clearTimeout(timer);
                    event(pending);
                    if (code !== 0 || failure || !completed || !answer) {
                        const detail = (failure || stderr || `exit ${code}, no completed answer`).slice(0, 500);
                        reject(new ClaudeError(`codex: ${detail}`, /limit|quota/i.test(detail) ? 'rate_limit' : 'transport'));
                    }
                    else
                        resolve(answer);
                });
                child.stdin.end(`You are a text-only assistant. Use no tools. Return only the requested JSON.\n\n${system}\n\nTASK\n${prompt}`);
            });
            runner.lastGeneration = { provider: 'codex', model: opts.model || 'CLI default' };
            return result;
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    };
    return runner;
}
