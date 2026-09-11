
CREATE TABLE scrape_run (
    id                  BIGSERIAL PRIMARY KEY,
    seed_account_id     INTEGER REFERENCES seed_account (id),
    post_id             INTEGER REFERENCES post (id),
    kind                TEXT NOT NULL CHECK (kind IN
                          ('posts', 'engagers', 'retirement_snapshot', 'company_posts')),
    actor               TEXT NOT NULL,
    mode                TEXT NOT NULL CHECK (mode IN ('live', 'replay', 'capture', 'dry_run')),
    results_count       INTEGER NOT NULL DEFAULT 0,
    new_count           INTEGER NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(10, 4) NOT NULL DEFAULT 0,
    outcome             TEXT NOT NULL,
    error               TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ
);

CREATE INDEX scrape_run_seed_idx ON scrape_run (seed_account_id, started_at DESC);
CREATE INDEX scrape_run_day_idx ON scrape_run (started_at DESC);

CREATE TABLE spend_ledger (
    id              BIGSERIAL PRIMARY KEY,
    day             DATE NOT NULL,
    category        TEXT NOT NULL CHECK (category IN
                      ('apify', 'apollo', 'match_run', 'claude', 'verify', 'serper')),
    amount_usd      NUMERIC(10, 4) NOT NULL,
    units           INTEGER NOT NULL DEFAULT 1,
    meta            JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX spend_ledger_day_idx ON spend_ledger (day, category);

CREATE TABLE pipeline_hold (
    id              BIGSERIAL PRIMARY KEY,
    subject_kind    TEXT NOT NULL CHECK (subject_kind IN
                      ('prospect', 'seed_account', 'post', 'touch', 'match_run', 'lane')),
    subject_id      INTEGER,
    stage           TEXT NOT NULL CHECK (stage IN
                      ('scrape', 'score', 'verify', 'enrich', 'draft', 'send', 'ingest', 'bridge')),
    reason          TEXT NOT NULL,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT
);

CREATE INDEX pipeline_hold_open_idx ON pipeline_hold (stage, created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE lane_state (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  TEXT
);

INSERT INTO lane_state (key, value, updated_by) VALUES
    ('email_lane_restriction', '{"mode":"all"}'::JSONB, 'migration'),
    ('linkedin_campaign', '{"paused":false}'::JSONB, 'migration'),
    ('kill_switch', '{"sending_enabled":false}'::JSONB, 'migration');

CREATE TABLE export_cursor (
    source          TEXT PRIMARY KEY,
    last_sequence   BIGINT NOT NULL DEFAULT 0,
    last_pulled_at  TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO export_cursor (source, last_sequence) VALUES
    ('platform_outcomes', 0),
    ('heyreach_replies', 0);

CREATE TABLE digest_run (
    id              BIGSERIAL PRIMARY KEY,
    day             DATE NOT NULL UNIQUE,
    markdown        TEXT NOT NULL,
    emailed         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE login_attempt (
    id              BIGSERIAL PRIMARY KEY,
    actor           TEXT,
    ip              TEXT,
    success         BOOLEAN NOT NULL,
    at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_attempt_recent_idx ON login_attempt (ip, at DESC);
