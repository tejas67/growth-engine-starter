
CREATE TABLE touch (
    id                      SERIAL PRIMARY KEY,
    prospect_id             INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    channel                 TEXT NOT NULL CHECK (channel IN ('email', 'dm', 'connect')),
    template_version        TEXT NOT NULL,
    angle                   TEXT CHECK (angle IN ('A1', 'A2', 'A3', 'A4')),
    sequence_step           SMALLINT NOT NULL DEFAULT 1,

    persona                 TEXT CHECK (persona IN ('P0', 'P1', 'P2', 'P3', 'P4')),
    seed_account_id         INTEGER REFERENCES seed_account (id),
    signal_type             TEXT CHECK (signal_type IN ('like', 'comment', 'repost', 'multi', 'none')),
    latency_bucket          TEXT CHECK (latency_bucket IN ('<1h', '1-4h', '4-12h', '12-24h', '1-3d', '>3d')),
    latency_from_detection  INTEGER,
    match_run_id            INTEGER REFERENCES match_run (id),
    no_proof                BOOLEAN NOT NULL DEFAULT FALSE,

    subject                 TEXT,
    body                    TEXT NOT NULL,
    content_hash            TEXT,
    ref_slug                TEXT GENERATED ALWAYS AS ('li-t' || id::TEXT) STORED UNIQUE,

    status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                              'draft', 'approved', 'skipped', 'queued',
                              'sent', 'failed', 'paused', 'suppressed'
                            )),
    founder_edited          BOOLEAN NOT NULL DEFAULT FALSE,
    hot                     BOOLEAN NOT NULL DEFAULT FALSE,
    drafted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at             TIMESTAMPTZ,
    approved_by             TEXT,
    skipped_at              TIMESTAMPTZ,
    sent_at                 TIMESTAMPTZ,
    failure_reason          TEXT,

    provider                TEXT,
    provider_message_id     TEXT,
    provider_thread_id      TEXT,
    email_message_id        TEXT,
    gmail_thread_url        TEXT,

    dry_run                 BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX touch_prospect_idx ON touch (prospect_id, drafted_at DESC);
CREATE INDEX touch_status_idx ON touch (status, hot DESC, drafted_at);
CREATE INDEX touch_message_id_idx ON touch (email_message_id) WHERE email_message_id IS NOT NULL;
CREATE INDEX touch_sent_idx ON touch (sent_at DESC) WHERE sent_at IS NOT NULL;

CREATE TABLE event (
    id              BIGSERIAL PRIMARY KEY,
    event_key       TEXT NOT NULL UNIQUE,
    touch_id        INTEGER REFERENCES touch (id) ON DELETE SET NULL,
    prospect_id     INTEGER REFERENCES prospect (id) ON DELETE SET NULL,
    kind            TEXT NOT NULL CHECK (kind IN (
                      'sent', 'delivered', 'clicked', 'claimed', 'signed_in', 'activated',
                      'bounced', 'hard_bounced', 'unsubscribed', 'reply', 'positive_reply',
                      'negative_reply', 'neutral_reply', 'connection_accept',
                      'meeting_booked', 'linkedin_restriction', 'unmatched_reply'
                    )),
    channel         TEXT CHECK (channel IN ('email', 'dm', 'connect')),
    source          TEXT NOT NULL CHECK (source IN
                      ('heyreach', 'imap', 'platform_export', 'dashboard', 'pipeline')),
    payload         JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX event_touch_idx ON event (touch_id);
CREATE INDEX event_prospect_idx ON event (prospect_id, occurred_at DESC);
CREATE INDEX event_kind_idx ON event (kind, occurred_at DESC);

CREATE TABLE suppression (
    id              SERIAL PRIMARY KEY,
    prospect_id     INTEGER REFERENCES prospect (id) ON DELETE CASCADE,
    alias_kind      TEXT NOT NULL CHECK (alias_kind IN
                      ('linkedin_url', 'linkedin_slug', 'email', 'platform_person_uuid')),
    alias_value     TEXT NOT NULL,
    reason          TEXT NOT NULL,
    source          TEXT NOT NULL,
    permanent       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (alias_kind, alias_value)
);

CREATE INDEX suppression_prospect_idx ON suppression (prospect_id);

CREATE TABLE approval_audit (
    id              BIGSERIAL PRIMARY KEY,
    touch_id        INTEGER NOT NULL REFERENCES touch (id) ON DELETE CASCADE,
    actor           TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('approve', 'edit', 'skip', 'unskip', 'reclassify')),
    before_hash     TEXT,
    after_hash      TEXT,
    detail          JSONB,
    at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX approval_audit_touch_idx ON approval_audit (touch_id, at DESC);
