import { config, type RunMode } from '../../config/index.js';
import { logger } from '../lib/log.js';
import { fixtureKey, readFixture, writeFixture } from './fixtures.js';
import type { FetchLike } from './apify.js';
const log = logger('millionverifier');
export type VerifyStatus = 'good' | 'catchall' | 'risky' | 'invalid' | 'unverified';
export interface VerifyResult {
    email: string;
    status: VerifyStatus;
    providerResult: string | null;
    raw: unknown;
    costUsd: number;
    effectiveMode: RunMode;
    reason: string | null;
}
export function mapVerifyResult(raw: unknown): VerifyStatus {
    const result = typeof raw === 'string'
        ? raw
        : typeof (raw as {
            result?: unknown;
        } | null)?.result === 'string'
            ? ((raw as {
                result: string;
            }).result)
            : null;
    if (!result)
        return 'unverified';
    switch (result.trim().toLowerCase()) {
        case 'ok':
            return 'good';
        case 'catch_all':
        case 'catchall':
            return 'catchall';
        case 'unknown':
        case 'disposable':
            return 'risky';
        case 'invalid':
            return 'invalid';
        case 'error':
        case 'timeout':
            return 'unverified';
        default:
            return 'unverified';
    }
}
function providerResultOf(raw: unknown): string | null {
    if (typeof raw === 'string')
        return raw;
    const result = (raw as {
        result?: unknown;
    } | null)?.result;
    return typeof result === 'string' ? result : null;
}
export interface MillionVerifierDeps {
    fetchImpl?: FetchLike;
}
export class MillionVerifierClient {
    private readonly fetchImpl: FetchLike;
    constructor(private readonly apiKey: string = config.emailVerify.apiKey, private readonly mode: RunMode = config.emailVerify.mode, deps: MillionVerifierDeps = {}) {
        this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    }
    get runMode(): RunMode {
        return this.mode;
    }
    get degraded(): boolean {
        return (this.mode === 'live' || this.mode === 'capture') && !this.apiKey;
    }
    async verify(email: string): Promise<VerifyResult> {
        const key = fixtureKey('millionverifier', email);
        if (this.mode === 'dry_run') {
            return this.unverified(email, 'dry_run', 'dry run — no verification was performed', null);
        }
        if (this.mode === 'replay') {
            const cached = await readFixture<unknown>(key);
            if (!cached)
                return this.unverified(email, 'replay', `no fixture for ${key}`, null);
            return {
                email,
                status: mapVerifyResult(cached),
                providerResult: providerResultOf(cached),
                raw: cached,
                costUsd: 0,
                effectiveMode: 'replay',
                reason: null,
            };
        }
        if (!this.apiKey) {
            log.warn('DEGRADED to unverified: MILLIONVERIFIER_KEY is not set', {
                configuredMode: this.mode,
                consequence: 'good/catchall/invalid cannot be distinguished; the lane sends and the tripwire measures',
            });
            return this.unverified(email, 'dry_run', 'MILLIONVERIFIER_KEY absent — no live call was made', null);
        }
        const timeoutSecs = Math.min(60, Math.max(2, Math.round(config.emailVerify.timeoutMs / 1000)));
        const url = `${config.emailVerify.baseUrl}/api/v3/` +
            `?api=${encodeURIComponent(this.apiKey)}` +
            `&email=${encodeURIComponent(email)}` +
            `&timeout=${timeoutSecs}`;
        let res: Response;
        try {
            res = await this.fetchImpl(url, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(config.emailVerify.timeoutMs),
            });
        }
        catch (err) {
            const reason = `verification transport failed: ${(err as Error).message}`;
            log.warn('DEGRADED to unverified: verification call failed', { email, error: (err as Error).message });
            return this.unverified(email, this.mode, reason, null);
        }
        if (!res.ok) {
            const reason = `verification returned HTTP ${res.status}`;
            log.warn('DEGRADED to unverified: verification returned an error status', { email, status: res.status });
            return this.unverified(email, this.mode, reason, null);
        }
        const body = await res.json().catch(() => null);
        if (this.mode === 'capture') {
            await writeFixture(key, body);
            log.info('captured millionverifier fixture', { key });
        }
        return {
            email,
            status: mapVerifyResult(body),
            providerResult: providerResultOf(body),
            raw: body,
            costUsd: config.emailVerify.costPerVerificationUsd,
            effectiveMode: this.mode,
            reason: null,
        };
    }
    async credits(): Promise<{
        ok: boolean;
        detail: string;
    }> {
        if (!this.apiKey)
            return { ok: false, detail: 'MILLIONVERIFIER_KEY absent' };
        const res = await this.fetchImpl(`${config.emailVerify.baseUrl}/api/v3/credits?api=${encodeURIComponent(this.apiKey)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok)
            return { ok: false, detail: `HTTP ${res.status}` };
        const body = (await res.json().catch(() => null)) as {
            credits?: number;
        } | null;
        return {
            ok: true,
            detail: typeof body?.credits === 'number' ? `${body.credits} credits remaining` : 'key accepted',
        };
    }
    private unverified(email: string, effectiveMode: RunMode, reason: string, raw: unknown): VerifyResult {
        return {
            email,
            status: 'unverified',
            providerResult: null,
            raw,
            costUsd: 0,
            effectiveMode,
            reason,
        };
    }
}
