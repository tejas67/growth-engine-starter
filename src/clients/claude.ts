import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logger } from '../lib/log.js';
import type { RunMode } from '../../config/index.js';
const log = logger('claude');
export interface ClaudeOptions {
    binary: string;
    model: string;
    timeoutMs: number;
    mode: RunMode;
}
export class ClaudeError extends Error {
    constructor(message: string, readonly kind: 'transport' | 'malformed' | 'refusal' | 'timeout' | 'rate_limit', readonly raw?: string) {
        super(message);
        this.name = 'ClaudeError';
    }
}
const CliEnvelope = z
    .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
})
    .passthrough();
const REFUSAL_MARKERS = [
    "i can't help with that",
    'i cannot help with that',
    "i won't",
    'i am unable to assist',
    "i'm not able to help",
];
export function stripFences(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
    return (fenced?.[1] ?? trimmed).trim();
}
export function looksLikeRefusal(text: string): boolean {
    const lower = text.toLowerCase();
    return REFUSAL_MARKERS.some((m) => lower.includes(m));
}
export interface GenerationInfo {
    provider: string;
    model: string;
}
export type ClaudeRunner = ((prompt: string, system: string) => Promise<string>) & {
    lastGeneration?: GenerationInfo;
};
export function parseCliResult(stdout: string, stderr: string, code: number | null): string {
    let json: unknown;
    try {
        json = JSON.parse(stdout || '{}');
    }
    catch {
        throw new ClaudeError(`claude CLI envelope unparseable (exit ${code})`, code === 0 ? 'malformed' : 'transport');
    }
    const envelope = CliEnvelope.safeParse(json);
    if (!envelope.success)
        throw new ClaudeError('claude CLI envelope unparseable', 'malformed');
    if (code !== 0 || envelope.data.is_error) {
        const detail = (envelope.data.result || stderr || `exit ${code}`).slice(0, 500)
            .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
        const limited = /(?:reached|hit|exceeded)[\s\S]{0,80}(?:limit|quota)|usage.limit|rate.limit|quota.exhaust/i.test(detail);
        throw new ClaudeError(`claude: ${detail}`, limited ? 'rate_limit' : 'transport');
    }
    return envelope.data.result ?? '';
}
export function cliRunner(opts: ClaudeOptions): ClaudeRunner {
    const runner: ClaudeRunner = async (prompt: string, system: string) => {
        const cwd = await mkdtemp(join(tmpdir(), 'growth-ai-'));
        try {
            return await new Promise<string>((resolve, reject) => {
                const args = [
                    '-p',
                    '--output-format',
                    'json',
                    ...(opts.model ? ['--model', opts.model] : []),
                    '--safe-mode',
                    '--strict-mcp-config',
                    '--mcp-config', '{"mcpServers":{}}',
                    '--allowedTools',
                    '',
                    '--tools',
                    '',
                    '--no-session-persistence',
                    '--append-system-prompt',
                    system,
                ];
                const child = spawn(opts.binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]!]])) });
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    reject(new ClaudeError(`claude timed out after ${opts.timeoutMs}ms`, 'timeout'));
                }, opts.timeoutMs);
                child.stdout.on('data', d => { stdout += String(d); if (stdout.length > 2000000) {
                    child.kill('SIGKILL');
                    reject(new ClaudeError('AI output exceeds size limit', 'malformed'));
                } });
                child.stderr.on('data', d => { stderr = (stderr + String(d)).slice(-1000); });
                child.stdin.on('error', () => { });
                child.on('error', (err) => {
                    clearTimeout(timer);
                    reject(new ClaudeError(`claude spawn failed: ${err.message}`, 'transport'));
                });
                child.on('close', (code) => {
                    clearTimeout(timer);
                    try {
                        const result = parseCliResult(stdout, stderr, code);
                        runner.lastGeneration = { provider: 'claude', model: opts.model || 'CLI default' };
                        resolve(result);
                    }
                    catch (err) {
                        reject(err);
                    }
                });
                child.stdin.write(prompt);
                child.stdin.end();
            });
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    };
    return runner;
}
export interface CallResult<T> {
    value: T;
    attempts: number;
    rawFinal: string;
}
export async function callStructured<T>(runner: ClaudeRunner, schema: z.ZodType<T>, prompt: string, system: string, maxRetries: number): Promise<CallResult<T>> {
    let lastRaw = '';
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const effectivePrompt = attempt === 1
            ? prompt
            : `${prompt}\n\nYour previous reply was not valid JSON matching the required schema. ` +
                `Reply with ONLY the JSON object, no prose, no code fences.`;
        const raw = await runner(effectivePrompt, system);
        lastRaw = raw;
        if (looksLikeRefusal(raw)) {
            throw new ClaudeError('model refused the request', 'refusal', raw.slice(0, 400));
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(stripFences(raw));
        }
        catch {
            log.warn('malformed JSON from claude', { attempt, sample: raw.slice(0, 160) });
            continue;
        }
        const result = schema.safeParse(parsed);
        if (result.success)
            return { value: result.data, attempts: attempt, rawFinal: raw };
        log.warn('schema validation failed', {
            attempt,
            issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
    }
    throw new ClaudeError(`output failed schema validation after ${maxRetries + 1} attempts`, 'malformed', lastRaw.slice(0, 400));
}
export function asQuotedData(label: string, text: string | null | undefined): string {
    const safe = (text ?? '')
        .replace(/```/g, "'''")
        .replace(/\r/g, '')
        .slice(0, 4000);
    return `<${label}>\n${safe}\n</${label}>`;
}
