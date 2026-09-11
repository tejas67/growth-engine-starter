
ALTER TABLE seed_account ADD COLUMN unipile_provider_id TEXT;
ALTER TABLE post ADD COLUMN unipile_social_id TEXT;
ALTER TABLE post ADD COLUMN unipile_poll_state JSONB NOT NULL DEFAULT '{}';

ALTER TABLE prospect
    ADD COLUMN is_open_profile   BOOLEAN,
    ADD COLUMN network_distance  TEXT,
    ADD COLUMN resolve_outcome   TEXT CHECK (resolve_outcome IN ('resolved', 'not_found', 'no_slug')),
    ADD COLUMN resolved_at       TIMESTAMPTZ;

CREATE INDEX prospect_resolve_idx ON prospect (first_detected_at)
    WHERE resolve_outcome IS NULL AND canonical_prospect_id IS NULL;

ALTER TABLE spend_ledger DROP CONSTRAINT spend_ledger_category_check;

ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_category_check CHECK (category IN
    ('apify', 'apollo', 'match_run', 'claude', 'verify', 'serper', 'unipile', 'unipile_profile'));

ALTER TABLE pipeline_hold DROP CONSTRAINT pipeline_hold_stage_check;

ALTER TABLE pipeline_hold ADD CONSTRAINT pipeline_hold_stage_check CHECK (stage IN
    ('scrape', 'score', 'verify', 'enrich', 'draft', 'send', 'ingest', 'bridge', 'resolve'));
