import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../../config/index.js';
import { closeDb, db } from '../../db/client.js';
import { ApifyClient } from '../clients/apify.js';
import { ApolloClient } from '../clients/apollo.js';
import { HeyReachClient } from '../clients/heyreach.js';
import { ImapFlowReader } from '../clients/imap.js';
import { MillionVerifierClient } from '../clients/millionverifier.js';
import { UnipileClient, type UnipileAccount } from '../clients/unipile.js';
import { BridgeClient } from '../pipeline/bridge.js';
import { liveDraftRunner } from '../clients/draft_runner.js';
const execFileAsync = promisify(execFile);
type Mode = 'LIVE' | 'DRY';
type Probe = 'ok' | 'FAIL' | 'skipped' | '-';
interface Row {
    name: string;
    mode: Mode;
    probe: Probe;
    detail: string;
}
function dry(name: string, detail: string): Row {
    return { name, mode: 'DRY', probe: '-', detail };
}
function skipped(name: string, detail: string): Row {
    return { name, mode: 'LIVE', probe: 'skipped', detail };
}
function describeError(err: unknown): string {
    if (err instanceof AggregateError && err.errors.length > 0) {
        const parts = err.errors.map((e) => describeError(e));
        return [...new Set(parts)].join('; ');
    }
    if (err instanceof Error) {
        const cause = err.cause ? describeError(err.cause) : '';
        const base = err.message || err.name || 'threw a non-descript error';
        return cause && !base.includes(cause) ? `${base} (${cause})` : base;
    }
    return String(err) || 'threw a non-descript value';
}
async function probed(name: string, fn: () => Promise<{
    ok: boolean;
    detail: string;
}>): Promise<Row> {
    try {
        const { ok, detail } = await fn();
        return { name, mode: 'LIVE', probe: ok ? 'ok' : 'FAIL', detail };
    }
    catch (err) {
        return { name, mode: 'LIVE', probe: 'FAIL', detail: describeError(err) };
    }
}
function degradedNote(modeVar: string, keyVar: string): string {
    return `${modeVar}=live but ${keyVar} is absent — runs degrade to offline, loudly`;
}
async function checkApify(): Promise<Row> {
    const wantsLive = config.scrape.mode === 'live' || config.scrape.mode === 'capture';
    if (!wantsLive) {
        return dry('apify', `GROWTH_SCRAPE_MODE=${config.scrape.mode} — scrapes read fixtures`);
    }
    if (!config.scrape.apifyToken) {
        return dry('apify', degradedNote('GROWTH_SCRAPE_MODE', 'APIFY_TOKEN'));
    }
    return probed('apify', () => new ApifyClient().whoAmI());
}
export function describeAccounts(accounts: UnipileAccount[], configuredId: string): {
    ok: boolean;
    detail: string;
} {
    if (accounts.length === 0) {
        return { ok: false, detail: 'key accepted but no connected accounts — connect the LinkedIn account in Unipile' };
    }
    const list = accounts
        .map((a) => `${a.type} ${a.id}${a.name ? ` (${a.name})` : ''}${a.status ? ` status=${a.status}` : ''}`)
        .join('; ');
    if (!configuredId) {
        return { ok: false, detail: `${accounts.length} account(s): ${list} — set UNIPILE_ACCOUNT_ID to one of these` };
    }
    const chosen = accounts.find((a) => a.id === configuredId);
    if (!chosen) {
        return { ok: false, detail: `UNIPILE_ACCOUNT_ID=${configuredId} is not among the ${accounts.length} account(s): ${list}` };
    }
    const healthy = !chosen.status || chosen.status.toUpperCase() === 'OK';
    return {
        ok: healthy,
        detail: `${accounts.length} account(s): ${list}; using ${chosen.id}${healthy ? '' : ' — NOT healthy, reconnect it in Unipile'}`,
    };
}
async function checkUnipile(): Promise<Row> {
    const active = config.scrape.source === 'unipile' ? 'the scrape source' : 'not the scrape source';
    if (config.unipile.mode !== 'live') {
        return dry('unipile', `GROWTH_UNIPILE_MODE=${config.unipile.mode} — no LinkedIn read is made (${active})`);
    }
    if (!config.unipile.dsn || !config.unipile.apiKey) {
        return { name: 'unipile', mode: 'LIVE', probe: 'FAIL', detail: degradedNote('GROWTH_UNIPILE_MODE', !config.unipile.dsn ? 'UNIPILE_DSN' : 'UNIPILE_API_KEY') };
    }
    return probed('unipile', async () => {
        const accounts = await new UnipileClient().listAccounts();
        const result = describeAccounts(accounts, config.unipile.accountId);
        return { ok: result.ok, detail: `${result.detail} (${active})` };
    });
}
async function checkApollo(): Promise<Row> {
    const wantsLive = config.enrich.mode === 'live' || config.enrich.mode === 'capture';
    if (!wantsLive) {
        return dry('apollo', `GROWTH_ENRICH_MODE=${config.enrich.mode} — no credits are spent`);
    }
    if (!config.enrich.apolloKey) {
        return dry('apollo', degradedNote('GROWTH_ENRICH_MODE', 'APOLLO_API_KEY'));
    }
    return probed('apollo', () => new ApolloClient().authHealth());
}
async function checkHeyReach(): Promise<Row> {
    if (config.dryRun) {
        return dry('heyreach', 'GROWTH_DRY_RUN=true — nothing can be transmitted');
    }
    if (!config.send.heyreachKey) {
        return dry('heyreach', degradedNote('GROWTH_DRY_RUN=false', 'HEYREACH_API_KEY'));
    }
    return probed('heyreach', () => new HeyReachClient().checkAuth());
}
async function checkMillionVerifier(): Promise<Row> {
    const wantsLive = config.emailVerify.mode === 'live' || config.emailVerify.mode === 'capture';
    if (!wantsLive) {
        return dry('millionverifier', `GROWTH_EMAIL_VERIFY_MODE=${config.emailVerify.mode} — every address stays unverified`);
    }
    if (!config.emailVerify.apiKey) {
        return dry('millionverifier', degradedNote('GROWTH_EMAIL_VERIFY_MODE', 'MILLIONVERIFIER_KEY'));
    }
    return probed('millionverifier', () => new MillionVerifierClient().credits());
}
async function checkSerper(): Promise<Row> {
    const wantsLive = config.verify.mode === 'live' || config.verify.mode === 'capture';
    if (!wantsLive) {
        return dry('serper', `GROWTH_VERIFY_MODE=${config.verify.mode} — no search is performed`);
    }
    if (!config.verify.serperKey) {
        return dry('serper', degradedNote('GROWTH_VERIFY_MODE', 'SERPER_API_KEY'));
    }
    return skipped('serper', `key present; probe skipped — the only probe is a billed search (~$${config.verify.costPerSearchUsd})`);
}
async function checkImap(): Promise<Row> {
    const reader = new ImapFlowReader();
    if (!config.ingest.imapEnabled) {
        return dry('imap', 'GROWTH_IMAP_ENABLED=false — email replies are triaged by hand');
    }
    if (!config.ingest.imapUser || !config.ingest.imapPassword) {
        return dry('imap', 'GROWTH_IMAP_ENABLED=true but IMAP_USER/IMAP_PASSWORD absent — no poll runs');
    }
    return probed('imap', async () => {
        const result = await reader.probe();
        return { ok: result.ok, detail: result.detail };
    });
}
async function checkClaude(): Promise<Row> {
    if (config.score.mode !== 'live') {
        return dry('claude', `GROWTH_LLM_MODE=${config.score.mode} — scoring and drafting use placeholders`);
    }
    return probed('claude', async () => {
        const { stdout } = await execFileAsync(config.score.binary, ['--version'], { timeout: 15000 });
        return { ok: true, detail: `${stdout.trim()} (installation only; draft-runner tests generation)` };
    });
}
async function checkDraftRunner(): Promise<Row> {
    if (config.draft.mode !== 'live')
        return dry('draft-runner', 'LLM mode is offline');
    return probed('draft-runner', async () => {
        const runner = liveDraftRunner();
        const text = await runner('Return exactly {"ok":true}.', 'Diagnostic only. Use no tools. Return JSON.');
        const ok = JSON.parse(text).ok === true;
        return { ok, detail: `${runner.lastGeneration?.provider}/${runner.lastGeneration?.model}: authenticated generation ${ok ? 'passed' : 'failed'}` };
    });
}
async function checkBridge(): Promise<Row> {
    if (!config.bridge.enabled) {
        return dry('bridge', 'GROWTH_BRIDGE_ENABLED=false — approved emails print instead of sending');
    }
    if (!config.bridge.baseUrl || !config.bridge.serviceKey) {
        return dry('bridge', 'bridge enabled but GROWTH_BRIDGE_BASE_URL/GROWTH_BRIDGE_KEY absent');
    }
    return probed('bridge', async () => {
        const client = BridgeClient.fromConfig();
        if (!client.available) {
            return { ok: false, detail: `bridge client reports unavailable: ${client.unavailableReason}` };
        }
        const result = await client.suppressionCheck('doctor-probe@invalid.example');
        return {
            ok: true,
            detail: `${config.bridge.baseUrl} answered the service key (suppressed=${result.suppressed})`,
        };
    });
}
async function checkPostgres(): Promise<Row> {
    const safeUrl = config.database.url.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@');
    return probed('postgres', async () => {
        try {
            await db().query('SELECT 1');
            return { ok: true, detail: `SELECT 1 ok (${safeUrl})` };
        }
        catch (err) {
            return { ok: false, detail: `${describeError(err)} — target ${safeUrl}; try npm run db:up` };
        }
    });
}
function render(rows: Row[]): string {
    const header: Row = { name: 'INTEGRATION', mode: 'LIVE', probe: 'ok', detail: 'DETAIL' };
    const nameWidth = Math.max(header.name.length, ...rows.map((r) => r.name.length));
    const probeWidth = Math.max('PROBE'.length, ...rows.map((r) => r.probe.length));
    const lines = [
        `${'INTEGRATION'.padEnd(nameWidth)}  ${'MODE'.padEnd(4)}  ${'PROBE'.padEnd(probeWidth)}  DETAIL`,
    ];
    for (const row of rows) {
        lines.push(`${row.name.padEnd(nameWidth)}  ${row.mode.padEnd(4)}  ${row.probe.padEnd(probeWidth)}  ${row.detail}`);
    }
    return lines.join('\n');
}
async function main(): Promise<number> {
    const settled = await Promise.allSettled([
        checkApify(),
        checkUnipile(),
        checkApollo(),
        checkHeyReach(),
        checkMillionVerifier(),
        checkSerper(),
        checkImap(),
        checkClaude(),
        checkDraftRunner(),
        checkBridge(),
        checkPostgres(),
    ]);
    const rows: Row[] = settled.map((outcome, i) => outcome.status === 'fulfilled'
        ? outcome.value
        : {
            name: `check#${i}`,
            mode: 'LIVE' as const,
            probe: 'FAIL' as const,
            detail: `check itself threw: ${describeError(outcome.reason)}`,
        });
    console.log(render(rows));
    const live = rows.filter((r) => r.mode === 'LIVE');
    const failed = live.filter((r) => r.probe === 'FAIL');
    const skippedRows = live.filter((r) => r.probe === 'skipped');
    const ok = live.filter((r) => r.probe === 'ok');
    console.log(`\n${live.length} live, ${rows.length - live.length} dry — ` +
        `${ok.length} probed ok, ${failed.length} failed, ${skippedRows.length} skipped. ` +
        (failed.length === 0
            ? 'Nothing claims to work and does not.'
            : `Failing: ${failed.map((r) => r.name).join(', ')}.`));
    return failed.length === 0 ? 0 : 1;
}
main()
    .then(async (code) => {
    await closeDb();
    process.exitCode = code;
})
    .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exitCode = 1;
});
