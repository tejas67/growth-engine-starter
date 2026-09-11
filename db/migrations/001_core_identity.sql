
CREATE TABLE seed_account (
    id                      SERIAL PRIMARY KEY,
    slug                    TEXT NOT NULL UNIQUE,
    kind                    TEXT NOT NULL CHECK (kind IN ('person', 'company')),
    display_name            TEXT,
    linkedin_url            TEXT NOT NULL,
    tier                    SMALLINT NOT NULL DEFAULT 1,
    track                   BOOLEAN NOT NULL DEFAULT TRUE,
    cadence_class           TEXT NOT NULL DEFAULT 'unknown'
                              CHECK (cadence_class IN ('active', 'repost_heavy', 'dormant', 'unknown')),
    active                  BOOLEAN NOT NULL DEFAULT TRUE,
    consecutive_zero_days   INTEGER NOT NULL DEFAULT 0,
    last_zero_day           DATE,
    last_scraped_at         TIMESTAMPTZ,
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE post (
    id                          SERIAL PRIMARY KEY,
    linkedin_post_id            TEXT NOT NULL UNIQUE,
    post_url                    TEXT,
    author_slug                 TEXT,
    author_name                 TEXT,
    is_repost                   BOOLEAN NOT NULL DEFAULT FALSE,
    reposted_by_slug            TEXT,
    discovered_via_seed_id      INTEGER REFERENCES seed_account (id),
    content_text                TEXT,
    topic                       TEXT,
    posted_at                   TIMESTAMPTZ,
    first_seen_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_scraped_at             TIMESTAMPTZ,
    scrape_count                INTEGER NOT NULL DEFAULT 0,
    engager_count               INTEGER NOT NULL DEFAULT 0,
    retired_at                  TIMESTAMPTZ,
    retirement_snapshot_at      TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX post_active_idx ON post (retired_at, posted_at DESC);

CREATE TABLE post_seed_source (
    post_id             INTEGER NOT NULL REFERENCES post (id) ON DELETE CASCADE,
    seed_account_id     INTEGER NOT NULL REFERENCES seed_account (id) ON DELETE CASCADE,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (post_id, seed_account_id)
);

CREATE TABLE prospect (
    id                          SERIAL PRIMARY KEY,
    canonical_prospect_id       INTEGER REFERENCES prospect (id),
    linkedin_url                TEXT UNIQUE,
    linkedin_slug               TEXT,
    full_name                   TEXT,
    headline                    TEXT,
    location                    TEXT,
    country_class               TEXT NOT NULL DEFAULT 'unknown'
                                  CHECK (country_class IN ('US', 'non_US', 'unknown')),
    profile_json                JSONB,
    is_company_page             BOOLEAN NOT NULL DEFAULT FALSE,

    company_name                TEXT,
    company_domain              TEXT,
    company_verified            BOOLEAN NOT NULL DEFAULT FALSE,
    company_verified_at         TIMESTAMPTZ,
    company_verification_source TEXT,

    email                       TEXT,
    email_verify_status         TEXT CHECK (email_verify_status IN
                                  ('good', 'catchall', 'invalid', 'unknown', 'unverified')),
    is_gov                      BOOLEAN NOT NULL DEFAULT FALSE,
    gov_reason                  TEXT,

    platform_person_uuid        UUID,

    state                       TEXT NOT NULL DEFAULT 'new' CHECK (state IN (
                                  'new', 'scored', 'held', 'enriched', 'verified',
                                  'drafted', 'approved', 'sent', 'paused',
                                  'suppressed', 'rejected', 'merged'
                                )),
    hold_reason                 TEXT,
    sequence_paused_at          TIMESTAMPTZ,
    sequence_pause_reason       TEXT,

    first_detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX prospect_canonical_idx ON prospect (canonical_prospect_id);
CREATE INDEX prospect_state_idx ON prospect (state);
CREATE UNIQUE INDEX prospect_email_lower_idx ON prospect (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE prospect_alias (
    id              SERIAL PRIMARY KEY,
    prospect_id     INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    alias_kind      TEXT NOT NULL CHECK (alias_kind IN
                      ('linkedin_url', 'linkedin_slug', 'email', 'platform_person_uuid')),
    alias_value     TEXT NOT NULL,
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (alias_kind, alias_value)
);

CREATE INDEX prospect_alias_prospect_idx ON prospect_alias (prospect_id);

CREATE TABLE engagement (
    id                      SERIAL PRIMARY KEY,
    post_id                 INTEGER NOT NULL REFERENCES post (id) ON DELETE CASCADE,
    prospect_id             INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    engagement_type         TEXT NOT NULL CHECK (engagement_type IN ('like', 'comment', 'repost')),
    raw_reaction_type       TEXT,
    comment_text            TEXT,
    comment_pruned_at       TIMESTAMPTZ,
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scrape_window_start     TIMESTAMPTZ,
    scrape_window_end       TIMESTAMPTZ,
    occurred_at             TIMESTAMPTZ,
    UNIQUE (post_id, prospect_id, engagement_type)
);

CREATE INDEX engagement_prospect_idx ON engagement (prospect_id);
CREATE INDEX engagement_detected_idx ON engagement (detected_at DESC);
