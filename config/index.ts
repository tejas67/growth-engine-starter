import 'dotenv/config';
import { readSettings, readSecret } from './local.js';
function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        throw new Error(`${name} must be numeric, got ${raw}`);
    return parsed;
}
function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    return raw === 'true' || raw === '1';
}
function str(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? fallback : raw;
}
export type RunMode = 'live' | 'replay' | 'capture' | 'dry_run';
function mode(name: string, fallback: RunMode): RunMode {
    const raw = str(name, fallback);
    if (raw !== 'live' && raw !== 'replay' && raw !== 'capture' && raw !== 'dry_run') {
        throw new Error(`${name} must be one of live|replay|capture|dry_run, got ${raw}`);
    }
    return raw;
}
export const POSTED_WINDOWS = ['any', '1h', '24h', 'week', 'month', '3months', '6months', 'year'] as const;
export type PostedWindow = (typeof POSTED_WINDOWS)[number];
function postedWindow(name: string, fallback: PostedWindow): PostedWindow {
    const raw = str(name, fallback);
    if (!(POSTED_WINDOWS as readonly string[]).includes(raw)) {
        throw new Error(`${name} must be one of ${POSTED_WINDOWS.join('|')}, got ${raw}`);
    }
    return raw as PostedWindow;
}
export const COMMENT_WINDOWS = ['any', '1h', '24h', 'week', 'month'] as const;
export type CommentWindow = (typeof COMMENT_WINDOWS)[number];
function commentWindow(name: string, fallback: CommentWindow): CommentWindow {
    const raw = str(name, fallback);
    if (!(COMMENT_WINDOWS as readonly string[]).includes(raw)) {
        throw new Error(`${name} must be one of ${COMMENT_WINDOWS.join('|')}, got ${raw}`);
    }
    return raw as CommentWindow;
}
export const SCRAPE_SOURCES = ['harvestapi', 'unipile'] as const;
export type ScrapeSource = (typeof SCRAPE_SOURCES)[number];
export function scrapeSource(raw: string | undefined): ScrapeSource {
    const value = raw === undefined || raw === '' ? 'harvestapi' : raw;
    if (!(SCRAPE_SOURCES as readonly string[]).includes(value)) {
        throw new Error(`GROWTH_SCRAPE_SOURCE must be one of ${SCRAPE_SOURCES.join('|')}, got ${value}`);
    }
    return value as ScrapeSource;
}
export type UnipileMode = 'live' | 'dry_run';
function unipileMode(name: string, fallback: UnipileMode): UnipileMode {
    const raw = str(name, fallback);
    if (raw !== 'live' && raw !== 'dry_run') {
        throw new Error(`${name} must be one of live|dry_run, got ${raw}`);
    }
    return raw;
}
export function companySeedSource(raw: string | undefined): ScrapeSource {
    const value = raw === undefined || raw === '' ? 'harvestapi' : raw;
    if (!(SCRAPE_SOURCES as readonly string[]).includes(value)) {
        throw new Error(`GROWTH_UNIPILE_COMPANY_SEEDS must be one of ${SCRAPE_SOURCES.join('|')}, got ${value}`);
    }
    return value as ScrapeSource;
}
export const config = {
    env: str('NODE_ENV', 'development'),
    database: {
        url: str('GROWTH_DATABASE_URL', 'postgres://growth:setup-required@127.0.0.1:5447/growth_starter'),
        poolMax: num('GROWTH_DB_POOL_MAX', 8),
    },
    get dryRun() { return !readSettings().integrations.sendingEnabled; },
    scrape: {
        source: 'unipile' as ScrapeSource,
        mode: mode('GROWTH_SCRAPE_MODE', 'replay'),
        allowOfflineWrites: bool('GROWTH_ALLOW_OFFLINE_SCRAPE_WRITES', false),
        apifyToken: str('APIFY_TOKEN', ''),
        apifyBaseUrl: str('APIFY_BASE_URL', 'https://api.apify.com'),
        maxTotalChargeUsd: num('GROWTH_APIFY_MAX_CHARGE_PER_RUN_USD', 1.0),
        runPollIntervalMs: num('GROWTH_APIFY_POLL_INTERVAL_MS', 5000),
        runTimeoutMs: num('GROWTH_APIFY_RUN_TIMEOUT_MS', 600000),
        actors: {
            profilePosts: str('APIFY_ACTOR_PROFILE_POSTS', 'harvestapi/linkedin-profile-posts'),
            companyPosts: str('APIFY_ACTOR_COMPANY_POSTS', 'harvestapi/linkedin-company-posts'),
            postReactions: str('APIFY_ACTOR_POST_REACTIONS', 'harvestapi/linkedin-post-reactions'),
        },
        maxPosts: num('GROWTH_SCRAPE_MAX_POSTS', 5),
        postedWindow: postedWindow('GROWTH_SCRAPE_POSTED_WINDOW', 'week'),
        firstPollWindow: postedWindow('GROWTH_SCRAPE_FIRST_POLL_WINDOW', 'month'),
        maxComments: num('GROWTH_SCRAPE_MAX_COMMENTS', 30),
        commentsWindow: commentWindow('GROWTH_SCRAPE_COMMENTS_WINDOW', 'week'),
        maxReactionsPerPost: num('GROWTH_SCRAPE_MAX_REACTIONS', 100),
        maxPostsPerTick: num('GROWTH_SCRAPE_MAX_POSTS_PER_TICK', 25),
        contextCountry: str('GROWTH_SCRAPE_CONTEXT_COUNTRY', 'US'),
        costPerEngagerUsd: num('GROWTH_SCRAPE_COST_PER_ENGAGER', 0.004),
        costPerPostUsd: num('GROWTH_SCRAPE_COST_PER_POST', 0.002),
        costPerCommentUsd: num('GROWTH_SCRAPE_COST_PER_COMMENT', 0.002),
        dailySpendCapUsd: num('GROWTH_SCRAPE_DAILY_CAP_USD', 6.0),
        retireAfterDays: num('GROWTH_SCRAPE_RETIRE_AFTER_DAYS', 4),
        zeroDaysBeforeFlag: num('GROWTH_SCRAPE_ZERO_DAYS_BEFORE_FLAG', 3),
        cadenceMinutes: {
            newPostDetect: num('GROWTH_CADENCE_POST_DETECT_MIN', 120),
            engagersFresh: num('GROWTH_CADENCE_ENGAGERS_FRESH_MIN', 45),
            engagersTail: num('GROWTH_CADENCE_ENGAGERS_TAIL_MIN', 360),
            dormantPostDetect: num('GROWTH_CADENCE_DORMANT_MIN', 10080),
        },
        fixturesDir: str('GROWTH_FIXTURES_DIR', 'fixtures'),
    },
    unipile: {
        get mode(): UnipileMode { return readSettings().integrations.discoveryEnabled ? 'live' : 'dry_run'; },
        get dsn() { return readSettings().integrations.unipileDsn; },
        get apiKey() { return readSecret('UNIPILE_API_KEY'); },
        get accountId() { return readSettings().integrations.unipileAccountId; },
        timeoutMs: num('GROWTH_UNIPILE_TIMEOUT_MS', 30000),
        dailyCallCap: num('GROWTH_UNIPILE_DAILY_CALL_CAP', 250),
        dailyActionCap: num('GROWTH_UNIPILE_DAILY_ACTION_CAP', 100),
        dailyProfileCap: num('GROWTH_UNIPILE_DAILY_PROFILE_CAP', 100),
        minDelayMs: num('GROWTH_UNIPILE_MIN_DELAY_MS', 3000),
        maxDelayMs: num('GROWTH_UNIPILE_MAX_DELAY_MS', 10000),
        postsPerSeed: num('GROWTH_UNIPILE_POSTS_PER_SEED', 10),
        pageSize: num('GROWTH_UNIPILE_PAGE_SIZE', 100),
        resolveBatch: num('GROWTH_UNIPILE_RESOLVE_BATCH', 20),
        companySeeds: 'unipile' as ScrapeSource,
    },
    score: {
        get mode(): RunMode { return readSettings().ai.provider === 'demo' ? 'dry_run' : 'live'; },
        binary: str('CLAUDE_BINARY', 'claude'),
        model: str('GROWTH_SCORE_MODEL', 'sonnet'),
        rubricVersion: str('GROWTH_RUBRIC_VERSION', 'v0.4'),
        maxRetries: num('GROWTH_SCORE_MAX_RETRIES', 1),
        timeoutMs: num('GROWTH_SCORE_TIMEOUT_MS', 120000),
        batchSize: num('GROWTH_SCORE_BATCH_SIZE', 20),
        runBudgetMs: num('GROWTH_SCORE_RUN_BUDGET_MS', 8 * 60000),
        seedScoreFloor: num('GROWTH_SEED_SCORE_FLOOR', 70),
        holdDepthAlarm: num('GROWTH_HOLD_DEPTH_ALARM', 25),
        holdRetryHours: num('GROWTH_HOLD_RETRY_HOURS', 6),
    },
    verify: {
        get mode(): RunMode { return readSettings().integrations.verificationEnabled ? 'live' : 'dry_run'; },
        provider: str('GROWTH_VERIFY_PROVIDER', 'serper'),
        get serperKey() { return readSecret('SERPER_API_KEY'); },
        costPerSearchUsd: num('GROWTH_VERIFY_COST_PER_SEARCH', 0.001),
        dailyCap: num('GROWTH_VERIFY_DAILY_CAP', 100),
    },
    emailVerify: {
        mode: mode('GROWTH_EMAIL_VERIFY_MODE', 'dry_run'),
        apiKey: str('MILLIONVERIFIER_KEY', ''),
        baseUrl: str('MILLIONVERIFIER_BASE_URL', 'https://api.millionverifier.com'),
        timeoutMs: num('GROWTH_EMAIL_VERIFY_TIMEOUT_MS', 20000),
        dailyCap: num('GROWTH_EMAIL_VERIFY_DAILY_CAP', 200),
        costPerVerificationUsd: num('GROWTH_EMAIL_VERIFY_COST', 0.0059),
    },
    enrich: {
        get mode(): RunMode { return readSettings().integrations.enrichmentEnabled ? 'live' : 'dry_run'; },
        get apolloKey() { return readSecret('APOLLO_API_KEY'); },
        apolloBaseUrl: str('APOLLO_BASE_URL', 'https://api.apollo.io'),
        dailyCreditCap: num('GROWTH_APOLLO_DAILY_CAP', 100),
        costPerCreditUsd: num('GROWTH_APOLLO_COST_PER_CREDIT', 0.02),
        hitRateFloor: num('GROWTH_APOLLO_HITRATE_FLOOR', 0.6),
    },
    draft: {
        get mode(): RunMode { return readSettings().ai.provider === 'demo' ? 'dry_run' : 'live'; },
        binary: str('CLAUDE_BINARY', 'claude'),
        model: str('GROWTH_DRAFT_MODEL', 'sonnet'),
        fallbackEnabled: bool('GROWTH_DRAFT_FALLBACK_ENABLED', false),
        codexBinary: str('CODEX_BINARY', 'codex'),
        fallbackModel: str('GROWTH_DRAFT_FALLBACK_MODEL', ''),
        fallbackReasoningEffort: str('GROWTH_DRAFT_FALLBACK_REASONING_EFFORT', 'medium'),
        fallbackCooldownMs: num('GROWTH_DRAFT_FALLBACK_COOLDOWN_MIN', 60) * 60000,
        copywriterVersion: str('GROWTH_COPYWRITER_VERSION', 'v8'),
        maxRetries: num('GROWTH_DRAFT_MAX_RETRIES', 1),
        timeoutMs: num('GROWTH_DRAFT_TIMEOUT_MS', 120000),
        maxDraftsPerRun: num('GROWTH_MAX_DRAFTS_PER_RUN', 40),
        shapes: ['A-hw', 'B-intro'] as const,
    },
    send: {
        get dmEnabled() { return readSettings().integrations.sendingEnabled; },
        emailEnabled: false,
        get heyreachKey() { return readSecret('HEYREACH_API_KEY'); },
        heyreachBaseUrl: str('HEYREACH_BASE_URL', 'https://api.heyreach.io/api/public'),
        get heyreachCampaignId() { return readSettings().integrations.heyreachCampaignId; },
        get heyreachLinkedInAccountId() { return readSettings().integrations.heyreachAccountId; },
        ramp: {
            week1: { invitesPerDay: num('GROWTH_RAMP_W1_INVITES', 10), dmsPerDay: num('GROWTH_RAMP_W1_DMS', 15) },
            steady: { invitesPerDay: num('GROWTH_RAMP_STEADY_INVITES', 25), dmsPerDay: num('GROWTH_RAMP_STEADY_DMS', 30) },
            week1Days: num('GROWTH_RAMP_WEEK1_DAYS', 7),
            startDate: str('GROWTH_RAMP_START_DATE', ''),
        },
        emailPerDayCap: num('GROWTH_EMAIL_PER_DAY_CAP', 25),
        windowEtStartHour: num('GROWTH_SEND_WINDOW_START_ET', 9),
        windowEtEndHour: num('GROWTH_SEND_WINDOW_END_ET', 17),
    },
    bridge: {
        enabled: false,
        baseUrl: str('GROWTH_BRIDGE_BASE_URL', ''),
        serviceKey: str('GROWTH_BRIDGE_KEY', ''),
        timeoutMs: num('GROWTH_BRIDGE_TIMEOUT_MS', 30000),
        eventPageSize: num('GROWTH_BRIDGE_EVENT_PAGE_SIZE', 200),
        pollLimit: num('GROWTH_BRIDGE_POLL_LIMIT', 50),
        seedCapPerDay: num('GROWTH_SEED_CAP_PER_DAY', 20),
        matchRunCostUsd: num('GROWTH_MATCH_RUN_COST_USD', 0.35),
        matchFreshnessDays: num('GROWTH_MATCH_FRESHNESS_DAYS', 7),
        campaignKeyPrefix: str('GROWTH_CAMPAIGN_KEY_PREFIX', 'li-signal'),
        wave: str('GROWTH_WAVE', 'w1'),
    },
    ingest: {
        imapEnabled: false,
        imapHost: str('IMAP_HOST', 'imap.gmail.com'),
        imapPort: num('IMAP_PORT', 993),
        imapUser: str('IMAP_USER', ''),
        imapPassword: str('IMAP_PASSWORD', ''),
        imapMailbox: str('IMAP_MAILBOX', 'INBOX'),
        lookbackDays: num('GROWTH_IMAP_LOOKBACK_DAYS', 14),
        gmailDeepLinkBase: str('GROWTH_GMAIL_DEEPLINK', 'https://mail.google.com/mail/u/0/#all'),
    },
    guardrails: {
        frequencyCapDays: num('GROWTH_FREQUENCY_CAP_DAYS', 90),
        maxTouchesPerSequence: num('GROWTH_MAX_TOUCHES_PER_SEQUENCE', 3),
        sequenceSpanDays: num('GROWTH_SEQUENCE_SPAN_DAYS', 10),
        bounceTripwireCount: num('GROWTH_BOUNCE_TRIPWIRE_COUNT', 3),
        bounceTripwireWindow: num('GROWTH_BOUNCE_TRIPWIRE_WINDOW', 100),
        rawTextRetentionDays: num('GROWTH_RAW_TEXT_RETENTION_DAYS', 90),
    },
    dashboard: {
        user: str('GROWTH_DASHBOARD_USER', 'owner'),
        passwordHash: str('GROWTH_DASHBOARD_PASSWORD_HASH', ''),
        sessionSecret: str('GROWTH_SESSION_SECRET', ''),
        loginMaxAttempts: num('GROWTH_LOGIN_MAX_ATTEMPTS', 5),
        loginWindowMinutes: num('GROWTH_LOGIN_WINDOW_MINUTES', 15),
        minCellN: num('GROWTH_METRICS_MIN_CELL_N', 10),
    },
    report: {
        outDir: str('GROWTH_REPORT_DIR', 'report/out'),
        emailEnabled: bool('GROWTH_DIGEST_EMAIL_ENABLED', false),
        recipients: str('GROWTH_DIGEST_RECIPIENTS', '').split(',').filter(Boolean),
    },
    analyst: {
        get mode(): RunMode { return readSettings().ai.provider === 'demo' ? 'dry_run' : 'live'; },
        binary: str('CLAUDE_BINARY', 'claude'),
        model: str('GROWTH_ANALYST_MODEL', 'sonnet'),
        timeoutMs: num('GROWTH_ANALYST_TIMEOUT_MS', 300000),
        lookbackDays: num('GROWTH_ANALYST_LOOKBACK_DAYS', 14),
    },
    graduation: {
        minSends: num('GROWTH_GRADUATION_MIN_SENDS', 50),
        minPositiveReplyRate: num('GROWTH_GRADUATION_MIN_POSITIVE_RATE', 0.05),
    },
} as const;
export type Config = typeof config;
