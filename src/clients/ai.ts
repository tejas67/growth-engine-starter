import { config } from '../../config/index.js';
import { readSettings, profileReady, type LocalSettings } from '../../config/local.js';
import { ClaudeError, cliRunner, type ClaudeRunner } from './claude.js';
import { codexRunner } from './codex.js';
import { apiRunner } from './api_runner.js';
function providerRunner(provider: string, model: string): ClaudeRunner {
    if (provider === 'codex')
        return codexRunner({ binary: config.draft.codexBinary, model, reasoningEffort: 'medium', timeoutMs: config.draft.timeoutMs });
    if (provider === 'claude')
        return cliRunner({ binary: config.draft.binary, model, timeoutMs: config.draft.timeoutMs, mode: 'live' });
    if (provider === 'openai' || provider === 'anthropic' || provider === 'compatible') {
        return apiRunner({ provider, model, compatibleBaseUrl: readSettings().ai.compatibleBaseUrl, timeoutMs: config.draft.timeoutMs });
    }
    throw new ClaudeError('Choose an AI provider in Settings; demo mode makes no model calls', 'transport');
}
const cooldowns = new Map<string, number>();
export function liveAiRunner(): ClaudeRunner {
    const runner: ClaudeRunner = async (prompt, system) => {
        const settings = readSettings();
        if (!profileReady(settings))
            throw new ClaudeError('Complete your business, sender name, audience, and offer in Settings', 'transport');
        const { provider, model, fallback, fallbackModel } = settings.ai;
        const key = `${provider}:${model}`;
        const canFallback = fallback !== 'none' && fallback !== provider;
        if (!canFallback || (cooldowns.get(key) ?? 0) <= Date.now()) {
            const primary = providerRunner(provider, model);
            try {
                const result = await primary(prompt, system);
                runner.lastGeneration = primary.lastGeneration;
                return result;
            }
            catch (error) {
                if (!canFallback || !(error instanceof ClaudeError) || error.kind !== 'rate_limit')
                    throw error;
                cooldowns.set(key, Date.now() + 60 * 60000);
            }
        }
        const backup = providerRunner(fallback, fallbackModel);
        const result = await backup(prompt, system);
        runner.lastGeneration = backup.lastGeneration;
        return result;
    };
    return runner;
}
