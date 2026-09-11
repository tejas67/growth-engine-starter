
ALTER TABLE match_run DROP CONSTRAINT match_run_state_check;

ALTER TABLE match_run ADD CONSTRAINT match_run_state_check CHECK (state IN (
    'pending_seed',
    'seeded', 'awaiting_match', 'match_ready', 'awaiting_approval', 'approved',
    'sending', 'sent', 'send_failed', 'suppressed', 'skipped', 'revalidation_failed',
    'no_proof',
    'failed',
    'terminal'
));

ALTER TABLE match_run
    ADD COLUMN prospect_ref            TEXT UNIQUE,
    ADD COLUMN campaign_key            TEXT,
    ADD COLUMN touch_id                INTEGER REFERENCES touch (id) ON DELETE SET NULL,
    ADD COLUMN rendered_body_html      TEXT,
    ADD COLUMN last_polled_at          TIMESTAMPTZ,
    ADD COLUMN reused_from_match_run_id INTEGER REFERENCES match_run (id),
    ADD COLUMN updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX match_run_open_idx ON match_run (state, last_polled_at NULLS FIRST)
    WHERE state NOT IN ('sent', 'no_proof', 'failed', 'skipped', 'suppressed', 'terminal');

CREATE INDEX match_run_touch_idx ON match_run (touch_id) WHERE touch_id IS NOT NULL;

INSERT INTO export_cursor (source, last_sequence) VALUES ('growth_bridge', 0)
    ON CONFLICT (source) DO NOTHING;

ALTER TABLE event DROP CONSTRAINT event_kind_check;

ALTER TABLE event ADD CONSTRAINT event_kind_check CHECK (kind IN (
    'sent', 'delivered', 'clicked', 'claimed', 'signed_in', 'activated',
    'bounced', 'hard_bounced', 'unsubscribed', 'reply', 'positive_reply',
    'negative_reply', 'neutral_reply', 'connection_accept',
    'meeting_booked', 'linkedin_restriction', 'unmatched_reply',
    'seeded', 'match_ready', 'awaiting_approval', 'approved', 'send_failed',
    'suppressed', 'skipped', 'revalidation_failed', 'no_proof',
    'unknown_outcome'
));

ALTER TABLE prospect DROP CONSTRAINT prospect_email_verify_status_check;

ALTER TABLE prospect ADD CONSTRAINT prospect_email_verify_status_check
    CHECK (email_verify_status IN ('good', 'catchall', 'risky', 'invalid', 'unknown', 'unverified'));
