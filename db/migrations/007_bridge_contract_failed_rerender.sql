
ALTER TABLE event DROP CONSTRAINT event_kind_check;

ALTER TABLE event ADD CONSTRAINT event_kind_check CHECK (kind IN (
    'sent', 'delivered', 'clicked', 'claimed', 'signed_in', 'activated',
    'bounced', 'hard_bounced', 'unsubscribed', 'reply', 'positive_reply',
    'negative_reply', 'neutral_reply', 'connection_accept',
    'meeting_booked', 'linkedin_restriction', 'unmatched_reply',
    'seeded', 'match_ready', 'awaiting_approval', 'approved', 'send_failed',
    'suppressed', 'skipped', 'revalidation_failed', 'no_proof',
    'failed', 'rerender',
    'unknown_outcome'
));

DROP INDEX IF EXISTS match_run_no_proof_company_idx;

CREATE INDEX match_run_no_proof_company_idx
    ON match_run (company_key, created_at DESC)
    WHERE state = 'no_proof' AND match_count = 0;
