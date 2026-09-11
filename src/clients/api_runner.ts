import { ClaudeError, type ClaudeRunner } from './claude.js';
import { readSecret, type LocalSettings } from '../../config/local.js';
export interface ApiRunnerOptions {
    provider: 'openai' | 'anthropic' | 'compatible';
    model: string;
    compatibleBaseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
export function apiEndpoint(provider: ApiRunnerOptions['provider'], compatible = ''): string {
    if (provider === 'openai')
        return 'https://api.openai.com/v1/responses';
    if (provider === 'anthropic')
        return 'https://api.anthropic.com/v1/messages';
    const url = new URL(compatible);
    if (url.username || url.password || url.search || url.hash)
        throw new ClaudeError('Use a base URL without credentials, query, or fragment', 'transport');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new ClaudeError('API endpoints must use HTTPS; local loopback servers may use HTTP', 'transport');
    }
    return url.href.replace(/\/$/, '') + '/chat/completions';
}
export function apiRunner(opts: ApiRunnerOptions): ClaudeRunner {
    const runner: ClaudeRunner = async (prompt, system) => {
        if (!opts.model.trim())
            throw new ClaudeError('Choose a model in Settings before using an API provider', 'transport');
        const keyName = opts.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : opts.provider === 'compatible' ? 'COMPATIBLE_API_KEY' : 'OPENAI_API_KEY';
        const key = readSecret(keyName);
        const endpoint = apiEndpoint(opts.provider, opts.compatibleBaseUrl);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname);
        if (!key && !local)
            throw new ClaudeError(`Add ${keyName} in Settings`, 'transport');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        let body: unknown;
        if (opts.provider === 'anthropic') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
            body = { model: opts.model, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }], tools: [] };
        }
        else {
            if (key)
                headers.Authorization = `Bearer ${key}`;
            body = opts.provider === 'openai'
                ? { model: opts.model, instructions: system, input: prompt, store: false, tools: [], text: { format: { type: 'json_object' } } }
                : { model: opts.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false };
        }
        let response: Response;
        try {
            response = await (opts.fetchImpl ?? fetch)(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 120000), redirect: 'error' });
        }
        catch {
            throw new ClaudeError(`${opts.provider}: connection failed or timed out; check the endpoint and network`, 'transport');
        }
        if (!response.ok) {
            throw new ClaudeError(`${opts.provider}: HTTP ${response.status}; check the model, key, and account limits`, response.status === 429 ? 'rate_limit' : 'transport');
        }
        const raw = await response.text();
        if (raw.length > 2000000)
            throw new ClaudeError('API output exceeded the size limit', 'malformed');
        let data: any;
        try {
            data = JSON.parse(raw);
        }
        catch {
            throw new ClaudeError('API returned invalid JSON', 'malformed');
        }
        let answer = '';
        if (opts.provider === 'openai') {
            if (data.status !== 'completed' || !Array.isArray(data.output))
                throw new ClaudeError('OpenAI response did not complete', 'transport');
            for (const item of data.output) {
                if (item.type === 'reasoning')
                    continue;
                if (item.type !== 'message')
                    throw new ClaudeError('Unexpected tool output in text-only response', 'malformed');
                for (const part of item.content ?? []) {
                    if (part.type === 'refusal')
                        throw new ClaudeError('Model declined the request', 'refusal');
                    if (part.type === 'output_text')
                        answer += part.text;
                }
            }
        }
        else if (opts.provider === 'anthropic') {
            if (data.stop_reason !== 'end_turn')
                throw new ClaudeError('Anthropic response did not complete', 'transport');
            for (const part of data.content ?? []) {
                if (part.type !== 'text')
                    throw new ClaudeError('Unexpected non-text API output', 'malformed');
                answer += part.text;
            }
        }
        else {
            const choice = data.choices?.[0];
            if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length)
                throw new ClaudeError('Compatible API response did not complete as text', 'transport');
            answer = choice.message?.content ?? '';
        }
        if (typeof answer !== 'string' || !answer.trim())
            throw new ClaudeError('API returned no text', 'malformed');
        runner.lastGeneration = { provider: opts.provider, model: typeof data.model === 'string' ? data.model : opts.model };
        return answer;
    };
    return runner;
}
