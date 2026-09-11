
CREATE TABLE icp_assessment (
    id                  SERIAL PRIMARY KEY,
    prospect_id         INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    rubric_version      TEXT NOT NULL,
    score               INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    persona             TEXT NOT NULL CHECK (persona IN ('P0', 'P1', 'P2', 'P3', 'P4')),
    persona_subtype     TEXT CHECK (persona_subtype IN (
                          'P0-seller', 'P0-competitor', 'P0-geo', 'P0-student',
                          'P0-prime', 'P0-seed-graph', 'P0-author-colleague', 'P0-company-page'
                        )),
    reasoning           TEXT NOT NULL,
    verification_required BOOLEAN NOT NULL DEFAULT TRUE,
    stage               TEXT NOT NULL CHECK (stage IN ('pre_enrich', 'post_enrich', 'post_verify')),
    model               TEXT,
    input_hash          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX icp_assessment_prospect_idx ON icp_assessment (prospect_id, created_at DESC);
CREATE INDEX icp_assessment_rubric_idx ON icp_assessment (rubric_version);

CREATE TABLE enrichment (
    id                  SERIAL PRIMARY KEY,
    prospect_id         INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    matched             BOOLEAN NOT NULL DEFAULT FALSE,
    cost_usd            NUMERIC(10, 4) NOT NULL DEFAULT 0,
    email               TEXT,
    verify_status       TEXT,
    firmographics       JSONB,
    raw_response        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX enrichment_prospect_idx ON enrichment (prospect_id, created_at DESC);

CREATE TABLE company_verification (
    id                  SERIAL PRIMARY KEY,
    prospect_id         INTEGER NOT NULL REFERENCES prospect (id) ON DELETE CASCADE,
    query               TEXT NOT NULL,
    provider            TEXT NOT NULL,
    verdict             TEXT NOT NULL CHECK (verdict IN ('verified', 'contradicted', 'inconclusive')),
    verified_domain     TEXT,
    summary             TEXT,
    evidence            JSONB,
    cost_usd            NUMERIC(10, 4) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX company_verification_prospect_idx ON company_verification (prospect_id, created_at DESC);

CREATE TABLE match_run (
    id                      SERIAL PRIMARY KEY,
    company_key             TEXT NOT NULL,
    company_name            TEXT,
    company_domain          TEXT,
    requested_by_prospect_id INTEGER REFERENCES prospect (id),
    state                   TEXT NOT NULL DEFAULT 'pending_seed' CHECK (state IN (
                              'pending_seed', 'seeded', 'awaiting_approval',
                              'approved', 'sent', 'failed', 'terminal'
                            )),
    bridge_row_uuid         UUID,
    idempotency_key         TEXT UNIQUE,
    match_count             INTEGER,
    potential_total_usd     NUMERIC(14, 2),
    agencies                TEXT[],
    payload                 JSONB,
    rendered_subject        TEXT,
    rendered_body           TEXT,
    content_hash            TEXT,
    failure_reason          TEXT,
    seed_slot_refunded      BOOLEAN NOT NULL DEFAULT FALSE,
    cost_usd                NUMERIC(10, 4) NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seeded_at               TIMESTAMPTZ,
    fresh_until             TIMESTAMPTZ
);

CREATE INDEX match_run_company_idx ON match_run (company_key, created_at DESC);
CREATE INDEX match_run_state_idx ON match_run (state);
