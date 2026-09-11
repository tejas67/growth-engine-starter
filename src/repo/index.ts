import type { PoolClient } from 'pg';
import { db, withTx } from '../../db/client.js';
import { utcDay } from '../lib/time.js';
import { isInternalProfileUrl, linkedInSlug, normalizeAlias, normalizeLinkedInUrl, resolveCanonicalId, type Alias, type AliasKind, type AliasRow, type IdentityNode, } from '../lib/identity.js';
type Q = Pick<PoolClient, 'query'>;
function q(client?: Q): Q {
    return client ?? db();
}
export interface SeedAccountRow {
    id: number;
    slug: string;
    kind: 'person' | 'company';
    display_name: string | null;
    linkedin_url: string;
    tier: number;
    track: boolean;
    cadence_class: string;
    active: boolean;
    consecutive_zero_days: number;
    last_scraped_at: Date | null;
    company_name: string | null;
    unipile_provider_id: string | null;
}
export async function listTrackedSeeds(client?: Q): Promise<SeedAccountRow[]> {
    const { rows } = await q(client).query<SeedAccountRow>(`SELECT id, slug, kind, display_name, linkedin_url, tier, track, cadence_class,
            active, consecutive_zero_days, last_scraped_at, company_name, unipile_provider_id
       FROM seed_account
      WHERE active AND track
      ORDER BY tier, cadence_class, slug`);
    return rows;
}
export async function setSeedProviderId(seedId: number, providerId: string, client?: Q): Promise<void> {
    await q(client).query(`UPDATE seed_account
        SET unipile_provider_id = COALESCE(unipile_provider_id, $2), updated_at = NOW()
      WHERE id = $1`, [seedId, providerId]);
}
export async function upsertSeedAccount(input: {
    slug: string;
    kind: 'person' | 'company';
    displayName: string | null;
    linkedinUrl: string;
    tier: number;
    track: boolean;
    cadenceClass: string;
    notes: string | null;
    companyName?: string | null;
}, client?: Q): Promise<{
    id: number;
    created: boolean;
}> {
    const { rows } = await q(client).query<{
        id: number;
        created: boolean;
    }>(`INSERT INTO seed_account (slug, kind, display_name, linkedin_url, tier, track, cadence_class, notes, company_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (slug) DO UPDATE SET
       kind = EXCLUDED.kind,
       -- Enrich-not-replace: an authored display name/notes is never blanked by a re-load.
       display_name = COALESCE(EXCLUDED.display_name, seed_account.display_name),
       linkedin_url = EXCLUDED.linkedin_url,
       tier = EXCLUDED.tier,
       track = EXCLUDED.track,
       cadence_class = EXCLUDED.cadence_class,
       notes = COALESCE(EXCLUDED.notes, seed_account.notes),
       company_name = COALESCE(EXCLUDED.company_name, seed_account.company_name),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS created`, [
        input.slug,
        input.kind,
        input.displayName,
        input.linkedinUrl,
        input.tier,
        input.track,
        input.cadenceClass,
        input.notes,
        input.companyName ?? null,
    ]);
    return rows[0]!;
}
export async function recordZeroDay(seedId: number, consecutiveZeroDays: number, sawEngagers: boolean, client?: Q): Promise<void> {
    await q(client).query(`UPDATE seed_account
        SET consecutive_zero_days = $2,
            last_zero_day = CASE WHEN $3 THEN last_zero_day ELSE CURRENT_DATE END,
            last_scraped_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`, [seedId, consecutiveZeroDays, sawEngagers]);
}
export interface PostRow {
    id: number;
    linkedin_post_id: string;
    unipile_social_id?: string | null;
    unipile_poll_state?: UnipilePollState;
    post_url: string | null;
    author_slug: string | null;
    posted_at: Date | null;
    last_scraped_at: Date | null;
    scrape_count: number;
    retired_at: Date | null;
    retirement_snapshot_at: Date | null;
}
export interface UnipilePollState {
    started_at?: string;
    reactions?: {
        cursor: string | null;
        complete: boolean;
    };
    comments?: {
        cursor: string | null;
        complete: boolean;
    };
    results?: number;
    new_count?: number;
}
export async function saveUnipilePollState(postId: number, state: UnipilePollState): Promise<void> {
    await db().query('UPDATE post SET unipile_poll_state=$2 WHERE id=$1', [postId, JSON.stringify(state)]);
}
export interface UpsertPostInput {
    linkedinPostId: string;
    unipileSocialId?: string | null;
    postUrl: string | null;
    authorSlug: string | null;
    authorName: string | null;
    authorHeadline?: string | null;
    isRepost: boolean;
    repostedBySlug: string | null;
    discoveredViaSeedId: number | null;
    contentText: string | null;
    postedAt: Date | null;
}
export async function upsertPost(input: UpsertPostInput, client?: Q): Promise<{
    id: number;
    created: boolean;
}> {
    const { rows } = await q(client).query<{
        id: number;
        created: boolean;
    }>(`INSERT INTO post (linkedin_post_id, post_url, author_slug, author_name, author_headline,
                       is_repost, reposted_by_slug, discovered_via_seed_id, content_text, posted_at, unipile_social_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (linkedin_post_id) DO UPDATE SET
       post_url = COALESCE(post.post_url, EXCLUDED.post_url),
       author_slug = COALESCE(post.author_slug, EXCLUDED.author_slug),
       author_name = COALESCE(post.author_name, EXCLUDED.author_name),
       author_headline = COALESCE(post.author_headline, EXCLUDED.author_headline),
       content_text = COALESCE(post.content_text, EXCLUDED.content_text),
       posted_at = COALESCE(post.posted_at, EXCLUDED.posted_at),
       unipile_social_id = COALESCE(EXCLUDED.unipile_social_id, post.unipile_social_id)
     RETURNING id, (xmax = 0) AS created`, [
        input.linkedinPostId,
        input.postUrl,
        input.authorSlug,
        input.authorName,
        input.authorHeadline ?? null,
        input.isRepost,
        input.repostedBySlug,
        input.discoveredViaSeedId,
        input.contentText,
        input.postedAt,
        input.unipileSocialId ?? null,
    ]);
    const row = rows[0]!;
    if (input.discoveredViaSeedId) {
        await q(client).query(`INSERT INTO post_seed_source (post_id, seed_account_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [row.id, input.discoveredViaSeedId]);
    }
    return row;
}
export async function listPollablePosts(client?: Q): Promise<PostRow[]> {
    const { rows } = await q(client).query<PostRow>(`SELECT id, linkedin_post_id, post_url, author_slug, posted_at, last_scraped_at,
            scrape_count, retired_at, retirement_snapshot_at, unipile_social_id, unipile_poll_state
       FROM post
      WHERE retired_at IS NULL
      ORDER BY last_scraped_at NULLS FIRST, posted_at DESC`);
    return rows;
}
export async function markPostScraped(postId: number, engagerCount: number, opts: {
    retirementSnapshot?: boolean;
    retire?: boolean;
    clearUnipileState?: boolean;
} = {}, client?: Q): Promise<void> {
    await q(client).query(`UPDATE post
        SET last_scraped_at = NOW(),
            scrape_count = scrape_count + 1,
            engager_count = GREATEST(post.engager_count, $2),
            retirement_snapshot_at = CASE WHEN $3 THEN NOW() ELSE retirement_snapshot_at END,
            retired_at = CASE WHEN $4 THEN NOW() ELSE retired_at END,
            unipile_poll_state = CASE WHEN $5 THEN '{}'::jsonb ELSE unipile_poll_state END
      WHERE id = $1`, [postId, engagerCount, opts.retirementSnapshot ?? false, opts.retire ?? false, opts.clearUnipileState ?? false]);
}
export interface ProspectRow {
    id: number;
    canonical_prospect_id: number | null;
    linkedin_url: string | null;
    linkedin_slug: string | null;
    full_name: string | null;
    headline: string | null;
    location: string | null;
    country_class: string;
    is_company_page: boolean;
    company_name: string | null;
    company_domain: string | null;
    company_verified: boolean;
    email: string | null;
    email_verify_status: string | null;
    is_gov: boolean;
    state: string;
    hold_reason: string | null;
    sequence_paused_at: Date | null;
    first_detected_at: Date;
}
export interface UpsertProspectInput {
    linkedinUrl: string;
    linkedinSlug: string | null;
    fullName: string | null;
    headline: string | null;
    location: string | null;
    countryClass: 'US' | 'non_US' | 'unknown';
    isCompanyPage: boolean;
    companyName: string | null;
    profileJson: unknown;
    aliasUrls?: string[];
}
async function reconcileIdentity(canonicalUrl: string, aliasUrls: string[], client?: Q): Promise<number | null> {
    const all = [...new Set([canonicalUrl, ...aliasUrls])];
    const { rows } = await q(client).query<{
        id: number;
        linkedin_url: string | null;
        canonical_prospect_id: number | null;
    }>(`WITH RECURSIVE matched AS (
     SELECT DISTINCT p.id, p.linkedin_url, p.canonical_prospect_id
       FROM prospect p
       LEFT JOIN prospect_alias a
         ON a.prospect_id = p.id AND a.alias_kind = 'linkedin_url'
      WHERE p.linkedin_url = ANY($1) OR a.alias_value = ANY($1)
     ), family AS (
       SELECT * FROM matched
       UNION
       SELECT p.id,p.linkedin_url,p.canonical_prospect_id FROM prospect p
         JOIN family f ON p.id=f.canonical_prospect_id
     ) SELECT * FROM family`, [all]);
    if (rows.length === 0)
        return null;
    const nodes = new Map<number, IdentityNode>(rows.map((r) => [r.id, { id: r.id, canonicalProspectId: r.canonical_prospect_id }]));
    const canonicalIds = [...new Set(rows.map((r) => resolveCanonicalId(nodes, r.id)))].sort((a, b) => a - b);
    const winnerId = canonicalIds[0]!;
    const loserIds = canonicalIds.slice(1);
    if (loserIds.length > 0) {
        await applyMerge(winnerId, loserIds, all.map((value) => ({ kind: 'linkedin_url' as const, value })), 'scrape-alias', client);
    }
    const winnerUrl = rows.find((r) => r.id === winnerId)?.linkedin_url ?? null;
    if (!winnerUrl || (winnerUrl !== canonicalUrl && isInternalProfileUrl(winnerUrl) && !isInternalProfileUrl(canonicalUrl))) {
        await q(client).query(`UPDATE prospect SET linkedin_url=NULL
      WHERE linkedin_url=$2 AND canonical_prospect_id=$1`, [winnerId, canonicalUrl]);
        await q(client).query(`UPDATE prospect
          SET linkedin_url = $2, linkedin_slug = $3, updated_at = NOW()
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM prospect WHERE linkedin_url = $2 AND id <> $1)`, [winnerId, canonicalUrl, linkedInSlug(canonicalUrl)]);
    }
    return winnerId;
}
export async function upsertProspect(input: UpsertProspectInput, client?: Q): Promise<{
    id: number;
    created: boolean;
}> {
    if (!client)
        return withTx(tx => upsertProspect(input, tx));
    await client.query("SELECT pg_advisory_xact_lock(hashtext('growth-prospect-identity'))");
    const aliasUrls = (input.aliasUrls ?? [])
        .map((u) => normalizeLinkedInUrl(u))
        .filter((u): u is string => Boolean(u) && u !== input.linkedinUrl);
    const knownId = await reconcileIdentity(input.linkedinUrl, aliasUrls, client);
    const result = knownId === null ? await q(client).query<{
        id: number;
        created: boolean;
    }>(`INSERT INTO prospect (linkedin_url, linkedin_slug, full_name, headline, location,
                           country_class, is_company_page, company_name, profile_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (linkedin_url) DO UPDATE SET
       full_name    = COALESCE(prospect.full_name, EXCLUDED.full_name),
       headline     = COALESCE(EXCLUDED.headline, prospect.headline),
       location     = COALESCE(EXCLUDED.location, prospect.location),
       country_class = CASE WHEN prospect.country_class = 'unknown'
                            THEN EXCLUDED.country_class ELSE prospect.country_class END,
       company_name = COALESCE(prospect.company_name, EXCLUDED.company_name),
       profile_json = COALESCE(EXCLUDED.profile_json, prospect.profile_json),
       updated_at   = NOW()
     RETURNING id, (xmax = 0) AS created`, [
        input.linkedinUrl,
        input.linkedinSlug,
        input.fullName,
        input.headline,
        input.location,
        input.countryClass,
        input.isCompanyPage,
        input.companyName,
        input.profileJson ? JSON.stringify(input.profileJson) : null,
    ]) : await client.query<{
        id: number;
        created: boolean;
    }>(`UPDATE prospect SET
      full_name=COALESCE(full_name,$2),headline=COALESCE($3,headline),
      location=COALESCE($4,location),country_class=CASE WHEN country_class='unknown' THEN $5 ELSE country_class END,
      company_name=COALESCE(company_name,$6),profile_json=COALESCE($7,profile_json),updated_at=NOW()
    WHERE id=$1 RETURNING id,false AS created`, [knownId, input.fullName, input.headline, input.location,
        input.countryClass, input.companyName, input.profileJson ? JSON.stringify(input.profileJson) : null]);
    const row = result.rows[0]!;
    await addAlias(row.id, { kind: 'linkedin_url', value: input.linkedinUrl }, 'scrape', client);
    if (input.linkedinSlug) {
        await addAlias(row.id, { kind: 'linkedin_slug', value: input.linkedinSlug }, 'scrape', client);
    }
    for (const alias of aliasUrls) {
        await addAlias(row.id, { kind: 'linkedin_url', value: alias }, 'scrape-alias', client);
        const slug = linkedInSlug(alias);
        if (slug)
            await addAlias(row.id, { kind: 'linkedin_slug', value: slug }, 'scrape-alias', client);
    }
    return row;
}
export async function addAlias(prospectId: number, alias: Alias, source: string, client?: Q): Promise<void> {
    const value = normalizeAlias(alias.kind, alias.value);
    if (!value)
        return;
    await q(client).query(`INSERT INTO prospect_alias (prospect_id, alias_kind, alias_value, source)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (alias_kind, alias_value) DO NOTHING`, [prospectId, alias.kind, value, source]);
}
export async function loadIdentityGraph(probes: Alias[], client?: Q): Promise<{
    aliasRows: AliasRow[];
    nodes: Map<number, IdentityNode>;
}> {
    const normalized = probes
        .map((p) => ({ kind: p.kind, value: normalizeAlias(p.kind, p.value) }))
        .filter((p): p is {
        kind: AliasKind;
        value: string;
    } => p.value !== null);
    if (normalized.length === 0)
        return { aliasRows: [], nodes: new Map() };
    const { rows: aliasHits } = await q(client).query<{
        prospect_id: number;
        alias_kind: AliasKind;
        alias_value: string;
    }>(`SELECT prospect_id, alias_kind, alias_value
       FROM prospect_alias
      WHERE (alias_kind, alias_value) IN (
        SELECT * FROM UNNEST($1::TEXT[], $2::TEXT[])
      )`, [normalized.map((n) => n.kind), normalized.map((n) => n.value)]);
    const ids = [...new Set(aliasHits.map((a) => a.prospect_id))];
    if (ids.length === 0)
        return { aliasRows: [], nodes: new Map() };
    const { rows: allAliases } = await q(client).query<{
        prospect_id: number;
        alias_kind: AliasKind;
        alias_value: string;
    }>(`SELECT prospect_id, alias_kind, alias_value FROM prospect_alias WHERE prospect_id = ANY($1)`, [ids]);
    const { rows: nodeRows } = await q(client).query<{
        id: number;
        canonical_prospect_id: number | null;
    }>(`WITH RECURSIVE chain AS (
        SELECT id, canonical_prospect_id FROM prospect WHERE id = ANY($1)
        UNION
        SELECT p.id, p.canonical_prospect_id
          FROM prospect p JOIN chain c ON p.id = c.canonical_prospect_id
     ) SELECT id, canonical_prospect_id FROM chain`, [ids]);
    return {
        aliasRows: allAliases.map((a) => ({
            prospectId: a.prospect_id,
            kind: a.alias_kind,
            value: a.alias_value,
        })),
        nodes: new Map(nodeRows.map((n) => [n.id, { id: n.id, canonicalProspectId: n.canonical_prospect_id }])),
    };
}
export async function applyMerge(winnerId: number, loserIds: number[], aliases: Alias[], source: string, outer?: Q): Promise<void> {
    if (loserIds.length === 0 && aliases.length === 0)
        return;
    const run = async (client: Q): Promise<void> => {
        if (loserIds.length > 0) {
            await client.query(`UPDATE prospect SET canonical_prospect_id = $1, state = 'merged', updated_at = NOW()
          WHERE id = ANY($2) AND id <> $1`, [winnerId, loserIds]);
            await client.query(`UPDATE touch SET prospect_id = $1 WHERE prospect_id = ANY($2)`, [
                winnerId,
                loserIds,
            ]);
            await client.query(`UPDATE event SET prospect_id = $1 WHERE prospect_id = ANY($2)`, [
                winnerId,
                loserIds,
            ]);
            await client.query(`INSERT INTO engagement(post_id,prospect_id,engagement_type,raw_reaction_type,
          comment_text,comment_pruned_at,detected_at,scrape_window_start,scrape_window_end,occurred_at)
        SELECT DISTINCT ON (post_id,engagement_type) post_id,$1,engagement_type,raw_reaction_type,
          comment_text,comment_pruned_at,detected_at,scrape_window_start,scrape_window_end,occurred_at
        FROM engagement WHERE prospect_id=ANY($2) ORDER BY post_id,engagement_type,detected_at
        ON CONFLICT(post_id,prospect_id,engagement_type) DO UPDATE SET
          comment_text=COALESCE(engagement.comment_text,EXCLUDED.comment_text),
          detected_at=LEAST(engagement.detected_at,EXCLUDED.detected_at)`, [winnerId, loserIds]);
            await client.query('DELETE FROM engagement WHERE prospect_id=ANY($1)', [loserIds]);
            await client.query('UPDATE icp_assessment SET prospect_id=$1 WHERE prospect_id=ANY($2)', [winnerId, loserIds]);
            await client.query(`UPDATE pipeline_hold SET subject_id=$1
        WHERE subject_kind='prospect' AND subject_id=ANY($2)`, [winnerId, loserIds]);
            await client.query(`UPDATE prospect p SET
          sequence_paused_at=COALESCE(p.sequence_paused_at,s.sequence_paused_at),
          sequence_pause_reason=COALESCE(p.sequence_pause_reason,s.sequence_pause_reason),
          is_gov=p.is_gov OR EXISTS(SELECT 1 FROM prospect WHERE id=ANY($2) AND is_gov)
        FROM (SELECT sequence_paused_at,sequence_pause_reason FROM prospect
          WHERE id=ANY($2) ORDER BY sequence_paused_at NULLS LAST LIMIT 1) s WHERE p.id=$1`, [winnerId, loserIds]);
            await client.query(`UPDATE prospect_alias SET prospect_id = $1 WHERE prospect_id = ANY($2)`, [winnerId, loserIds]);
        }
        for (const alias of aliases) {
            await addAlias(winnerId, alias, source, client);
        }
    };
    if (outer)
        await run(outer);
    else
        await withTx(run);
}
export async function canonicalIdFor(prospectId: number, client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        id: number;
        canonical_prospect_id: number | null;
    }>(`WITH RECURSIVE chain AS (
        SELECT id, canonical_prospect_id FROM prospect WHERE id = $1
        UNION
        SELECT p.id, p.canonical_prospect_id FROM prospect p JOIN chain c ON p.id = c.canonical_prospect_id
     ) SELECT id, canonical_prospect_id FROM chain`, [prospectId]);
    const nodes = new Map<number, IdentityNode>(rows.map((r) => [r.id, { id: r.id, canonicalProspectId: r.canonical_prospect_id }]));
    return resolveCanonicalId(nodes, prospectId);
}
export interface ResolveCandidateRow {
    id: number;
    linkedin_url: string;
    provider_id?: string | null;
    full_name: string | null;
    persona: string;
    score: number;
    first_detected_at: Date;
}
export async function listResolveCandidates(limit: number, client?: Q): Promise<ResolveCandidateRow[]> {
    const { rows } = await q(client).query<ResolveCandidateRow>(`SELECT p.id, p.linkedin_url, p.full_name, a.persona, a.score, p.first_detected_at,
            COALESCE(p.profile_json->>'id', p.profile_json->>'provider_id') AS provider_id
       FROM prospect p
       JOIN LATERAL (
         SELECT persona, score FROM icp_assessment a
          WHERE a.prospect_id = p.id ORDER BY a.created_at DESC LIMIT 1
       ) a ON TRUE
      WHERE p.canonical_prospect_id IS NULL
        AND p.resolve_outcome IS NULL
        AND p.linkedin_url ~* '/in/acoa[a-z0-9_-]{16,}$'
        AND a.persona IN ('P1','P2','P3')
        AND NOT p.is_gov
        AND p.state NOT IN ('merged', 'suppressed', 'rejected')
      ORDER BY a.score DESC, p.first_detected_at, p.id
      LIMIT $1`, [limit]);
    return rows;
}
export async function recordResolveOutcome(prospectIds: number[], patch: {
    outcome: 'resolved' | 'not_found' | 'no_slug';
    isOpenProfile?: boolean | null;
    networkDistance?: string | null;
}, client?: Q): Promise<void> {
    if (prospectIds.length === 0)
        return;
    await q(client).query(`UPDATE prospect
        SET resolve_outcome = $2,
            resolved_at = NOW(),
            is_open_profile = COALESCE($3, is_open_profile),
            network_distance = COALESCE($4, network_distance),
            updated_at = NOW()
      WHERE id = ANY($1)`, [[...new Set(prospectIds)], patch.outcome, patch.isOpenProfile ?? null, patch.networkDistance ?? null]);
}
export async function setProspectState(prospectId: number, state: string, holdReason: string | null, client?: Q): Promise<void> {
    await q(client).query(`UPDATE prospect SET state = $2, hold_reason = $3, updated_at = NOW() WHERE id = $1`, [prospectId, state, holdReason]);
}
export async function pauseSequence(prospectId: number, reason: string, client?: Q): Promise<void> {
    await q(client).query(`UPDATE prospect
        SET sequence_paused_at = COALESCE(sequence_paused_at, NOW()),
            sequence_pause_reason = COALESCE(sequence_pause_reason, $2),
            state = CASE WHEN state IN ('suppressed','merged') THEN state ELSE 'paused' END,
            updated_at = NOW()
      WHERE id = $1`, [prospectId, reason]);
    await q(client).query(`UPDATE touch SET status = 'paused'
      WHERE prospect_id = $1 AND status IN ('draft','approved','queued')`, [prospectId]);
}
export async function insertEngagement(input: {
    postId: number;
    prospectId: number;
    engagementType: 'like' | 'comment' | 'repost';
    rawReactionType: string | null;
    commentText: string | null;
    scrapeWindowStart: Date | null;
    scrapeWindowEnd: Date | null;
    occurredAt?: Date | null;
}, client?: Q): Promise<boolean> {
    const { rowCount } = await q(client).query(`INSERT INTO engagement (post_id, prospect_id, engagement_type, raw_reaction_type,
                             comment_text, scrape_window_start, scrape_window_end, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (post_id, prospect_id, engagement_type) DO NOTHING`, [
        input.postId,
        input.prospectId,
        input.engagementType,
        input.rawReactionType,
        input.commentText,
        input.scrapeWindowStart,
        input.scrapeWindowEnd,
        input.occurredAt ?? null,
    ]);
    return (rowCount ?? 0) > 0;
}
export async function pruneRawCommentText(retentionDays: number, client?: Q): Promise<number> {
    const { rowCount } = await q(client).query(`UPDATE engagement
        SET comment_text = NULL, comment_pruned_at = NOW()
      WHERE comment_text IS NOT NULL
        AND comment_pruned_at IS NULL
        AND detected_at < NOW() - ($1 || ' days')::INTERVAL`, [retentionDays]);
    return rowCount ?? 0;
}
export async function insertAssessment(input: {
    prospectId: number;
    rubricVersion: string;
    score: number;
    persona: string;
    personaSubtype: string | null;
    reasoning: string;
    verificationRequired: boolean;
    stage: 'pre_enrich' | 'post_enrich' | 'post_verify';
    model: string | null;
    inputHash: string | null;
}, client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        id: number;
    }>(`INSERT INTO icp_assessment (prospect_id, rubric_version, score, persona, persona_subtype,
                                 reasoning, verification_required, stage, model, input_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [
        input.prospectId,
        input.rubricVersion,
        input.score,
        input.persona,
        input.personaSubtype,
        input.reasoning,
        input.verificationRequired,
        input.stage,
        input.model,
        input.inputHash,
    ]);
    return rows[0]!.id;
}
export interface LatestAssessment {
    prospect_id: number;
    score: number;
    persona: string;
    persona_subtype: string | null;
    rubric_version: string;
    verification_required: boolean;
    stage: string;
}
export async function latestAssessments(prospectIds: number[], client?: Q): Promise<Map<number, LatestAssessment>> {
    if (prospectIds.length === 0)
        return new Map();
    const { rows } = await q(client).query<LatestAssessment>(`SELECT DISTINCT ON (prospect_id)
            prospect_id, score, persona, persona_subtype, rubric_version, verification_required, stage
       FROM icp_assessment
      WHERE prospect_id = ANY($1)
      ORDER BY prospect_id, created_at DESC`, [prospectIds]);
    return new Map(rows.map((r) => [r.prospect_id, r]));
}
export interface TouchRow {
    id: number;
    prospect_id: number;
    channel: 'email' | 'dm' | 'connect';
    template_version: string;
    generation_provider?: string | null;
    generation_model?: string | null;
    angle: string | null;
    persona: string | null;
    subject: string | null;
    body: string;
    connect_note: string | null;
    content_hash: string | null;
    ref_slug: string;
    status: string;
    founder_edited: boolean;
    hot: boolean;
    drafted_at: Date;
    approved_at: Date | null;
    sent_at: Date | null;
    dry_run: boolean;
    email_message_id: string | null;
    provider_thread_id: string | null;
}
export async function insertTouch(input: {
    prospectId: number;
    channel: 'email' | 'dm' | 'connect';
    templateVersion: string;
    generationProvider?: string | null;
    generationModel?: string | null;
    angle: string | null;
    persona: string | null;
    seedAccountId: number | null;
    signalType: string | null;
    latencyBucket: string | null;
    latencyFromDetection: number | null;
    matchRunId: number | null;
    noProof: boolean;
    subject: string | null;
    body: string;
    connectNote?: string | null;
    hot: boolean;
    sequenceStep: number;
    dryRun: boolean;
}, client?: Q): Promise<TouchRow> {
    const { rows } = await q(client).query<TouchRow>(`INSERT INTO touch (prospect_id, channel, template_version, angle, persona, seed_account_id,
                        signal_type, latency_bucket, latency_from_detection, match_run_id,
                        no_proof, subject, body, hot, sequence_step, dry_run, connect_note,
                        generation_provider, generation_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id, prospect_id, channel, template_version, angle, persona, subject, body,
               connect_note, content_hash, ref_slug, status, founder_edited, hot, drafted_at, approved_at,
               sent_at, dry_run, email_message_id, provider_thread_id, generation_provider, generation_model`, [
        input.prospectId,
        input.channel,
        input.templateVersion,
        input.angle,
        input.persona,
        input.seedAccountId,
        input.signalType,
        input.latencyBucket,
        input.latencyFromDetection,
        input.matchRunId,
        input.noProof,
        input.subject,
        input.body,
        input.hot,
        input.sequenceStep,
        input.dryRun,
        input.connectNote ?? null,
        input.generationProvider ?? null,
        input.generationModel ?? null,
    ]);
    return rows[0]!;
}
export async function listApprovalQueue(limit = 100, client?: Q, newestFirst = false): Promise<TouchRow[]> {
    const { rows } = await q(client).query<TouchRow>(`SELECT t.id, t.prospect_id, t.channel, t.template_version, t.angle, t.persona, t.subject,
            t.body, t.connect_note, t.content_hash, t.ref_slug, t.status, t.founder_edited, t.hot, t.drafted_at,
            t.approved_at, t.sent_at, t.dry_run, t.email_message_id, t.provider_thread_id,
            t.generation_provider, t.generation_model
       FROM touch t
       JOIN prospect p ON p.id = t.prospect_id
      WHERE t.status = 'draft'
        AND p.sequence_paused_at IS NULL
      ORDER BY t.hot DESC, CASE WHEN $2 THEN t.drafted_at END DESC, t.drafted_at ASC, t.id
      LIMIT $1`, [limit, newestFirst]);
    return rows;
}
export async function listApprovedTouches(limit = 100, client?: Q): Promise<TouchRow[]> {
    const { rows } = await q(client).query<TouchRow>(`SELECT id, prospect_id, channel, template_version, angle, persona, subject, body,
            connect_note, content_hash, ref_slug, status, founder_edited, hot, drafted_at, approved_at,
            sent_at, dry_run, email_message_id, provider_thread_id
       FROM touch
      WHERE status = 'approved' AND NOT EXISTS (SELECT 1 FROM prospect p WHERE p.id=touch.prospect_id AND p.is_demo) AND NOT EXISTS (SELECT 1 FROM dispatch_attempt d WHERE d.touch_id=touch.id)
      ORDER BY hot DESC, approved_at ASC
      LIMIT $1`, [limit]);
    return rows;
}
export async function touchesForProspect(prospectId: number, client?: Q): Promise<TouchRow[]> {
    const { rows } = await q(client).query<TouchRow>(`SELECT id, prospect_id, channel, template_version, angle, persona, subject, body,
            connect_note, content_hash, ref_slug, status, founder_edited, hot, drafted_at, approved_at,
            sent_at, dry_run, email_message_id, provider_thread_id
       FROM touch WHERE prospect_id = $1 ORDER BY drafted_at`, [prospectId]);
    return rows;
}
export async function persistTouchState(touchId: number, patch: {
    status?: string;
    subject?: string | null;
    body?: string;
    connectNote?: string | null;
    contentHash?: string | null;
    founderEdited?: boolean;
    approvedAt?: Date | null;
    approvedBy?: string | null;
    skippedAt?: Date | null;
}, client?: Q): Promise<void> {
    await q(client).query(`UPDATE touch SET
       status = COALESCE($2, status),
       subject = CASE WHEN $3::BOOLEAN THEN $4 ELSE subject END,
       body = COALESCE($5, body),
       content_hash = CASE WHEN $6::BOOLEAN THEN $7 ELSE content_hash END,
       founder_edited = COALESCE($8, founder_edited),
       approved_at = CASE WHEN $9::BOOLEAN THEN $10 ELSE approved_at END,
       approved_by = CASE WHEN $9::BOOLEAN THEN $11 ELSE approved_by END,
       skipped_at = COALESCE($12, skipped_at),
       connect_note = CASE WHEN $13::BOOLEAN THEN $14 ELSE connect_note END
     WHERE id = $1`, [
        touchId,
        patch.status ?? null,
        patch.subject !== undefined,
        patch.subject ?? null,
        patch.body ?? null,
        patch.contentHash !== undefined,
        patch.contentHash ?? null,
        patch.founderEdited ?? null,
        patch.approvedAt !== undefined,
        patch.approvedAt ?? null,
        patch.approvedBy ?? null,
        patch.skippedAt ?? null,
        patch.connectNote !== undefined,
        patch.connectNote ?? null,
    ]);
}
export async function markTouchSent(touchId: number, ids: {
    provider: string | null;
    providerMessageId: string | null;
    providerThreadId: string | null;
    emailMessageId: string | null;
    gmailThreadUrl: string | null;
    dryRun: boolean;
}, client?: Q): Promise<void> {
    await q(client).query(`UPDATE touch
        SET status = 'sent', sent_at = NOW(), provider = $2, provider_message_id = $3,
            provider_thread_id = $4, email_message_id = $5, gmail_thread_url = $6, dry_run = $7
      WHERE id = $1 AND status = 'approved'`, [
        touchId,
        ids.provider,
        ids.providerMessageId,
        ids.providerThreadId,
        ids.emailMessageId,
        ids.gmailThreadUrl,
        ids.dryRun,
    ]);
}
export async function insertAudit(entry: {
    touchId: number;
    actor: string;
    action: string;
    beforeHash: string | null;
    afterHash: string | null;
    detail?: unknown;
}, client?: Q): Promise<void> {
    await q(client).query(`INSERT INTO approval_audit (touch_id, actor, action, before_hash, after_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`, [
        entry.touchId,
        entry.actor,
        entry.action,
        entry.beforeHash,
        entry.afterHash,
        entry.detail ? JSON.stringify(entry.detail) : null,
    ]);
}
export interface MatchRunRow {
    id: number;
    prospect_ref: string | null;
    requested_by_prospect_id: number | null;
    company_key: string;
    company_name: string | null;
    company_domain: string | null;
    campaign_key: string | null;
    state: string;
    bridge_row_uuid: string | null;
    touch_id: number | null;
    match_count: number | null;
    potential_total_usd: string | null;
    payload: unknown;
    rendered_subject: string | null;
    rendered_body: string | null;
    rendered_body_html: string | null;
    content_hash: string | null;
    failure_reason: string | null;
    created_at: Date;
    seeded_at: Date | null;
    fresh_until: Date | null;
    last_polled_at: Date | null;
}
const MATCH_RUN_COLUMNS = `id, prospect_ref, requested_by_prospect_id, company_key, company_name,
       company_domain, campaign_key, state, bridge_row_uuid, touch_id, match_count,
       potential_total_usd::TEXT, payload, rendered_subject, rendered_body, rendered_body_html,
       content_hash, failure_reason, created_at, seeded_at, fresh_until, last_polled_at`;
export async function upsertMatchRun(input: {
    prospectRef: string;
    prospectId: number;
    companyKey: string;
    companyName: string | null;
    companyDomain: string | null;
    campaignKey: string;
    state: string;
    freshnessDays: number;
}, client?: Q): Promise<MatchRunRow> {
    const { rows } = await q(client).query<MatchRunRow>(`INSERT INTO match_run (prospect_ref, requested_by_prospect_id, company_key, company_name,
                            company_domain, campaign_key, state, idempotency_key, fresh_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$1, NOW() + ($8 || ' days')::INTERVAL)
     ON CONFLICT (prospect_ref) DO UPDATE SET updated_at = NOW()
     RETURNING ${MATCH_RUN_COLUMNS}`, [
        input.prospectRef,
        input.prospectId,
        input.companyKey,
        input.companyName,
        input.companyDomain,
        input.campaignKey,
        input.state,
        input.freshnessDays,
    ]);
    return rows[0]!;
}
export async function updateMatchRun(id: number, patch: {
    state?: string;
    bridgeRowUuid?: string | null;
    touchId?: number | null;
    matchCount?: number | null;
    potentialTotalUsd?: number | null;
    payload?: unknown;
    renderedSubject?: string | null;
    renderedBody?: string | null;
    renderedBodyHtml?: string | null;
    contentHash?: string | null;
    failureReason?: string | null;
    costUsd?: number | null;
    seeded?: boolean;
    polled?: boolean;
    reusedFromMatchRunId?: number | null;
}, client?: Q): Promise<void> {
    await q(client).query(`UPDATE match_run SET
       state = COALESCE($2::TEXT, state),
       bridge_row_uuid = COALESCE($3::UUID, bridge_row_uuid),
       touch_id = COALESCE($4::INTEGER, touch_id),
       match_count = COALESCE($5::INTEGER, match_count),
       potential_total_usd = COALESCE($6::NUMERIC, potential_total_usd),
       payload = COALESCE($7::JSONB, payload),
       rendered_subject = COALESCE($8::TEXT, rendered_subject),
       rendered_body = COALESCE($9::TEXT, rendered_body),
       rendered_body_html = COALESCE($10::TEXT, rendered_body_html),
       content_hash = COALESCE($11::TEXT, content_hash),
       failure_reason = COALESCE($12::TEXT, failure_reason),
       cost_usd = cost_usd + COALESCE($13::NUMERIC, 0),
       seeded_at = CASE WHEN $14::BOOLEAN THEN COALESCE(seeded_at, NOW()) ELSE seeded_at END,
       last_polled_at = CASE WHEN $15::BOOLEAN THEN NOW() ELSE last_polled_at END,
       reused_from_match_run_id = COALESCE($16::INTEGER, reused_from_match_run_id),
       updated_at = NOW()
     WHERE id = $1`, [
        id,
        patch.state ?? null,
        patch.bridgeRowUuid ?? null,
        patch.touchId ?? null,
        patch.matchCount ?? null,
        patch.potentialTotalUsd ?? null,
        patch.payload === undefined ? null : JSON.stringify(patch.payload),
        patch.renderedSubject ?? null,
        patch.renderedBody ?? null,
        patch.renderedBodyHtml ?? null,
        patch.contentHash ?? null,
        patch.failureReason ?? null,
        patch.costUsd ?? null,
        patch.seeded ?? false,
        patch.polled ?? false,
        patch.reusedFromMatchRunId ?? null,
    ]);
}
export async function listOpenMatchRuns(limit: number, client?: Q): Promise<MatchRunRow[]> {
    const { rows } = await q(client).query<MatchRunRow>(`SELECT ${MATCH_RUN_COLUMNS}
       FROM match_run
      WHERE bridge_row_uuid IS NOT NULL
        AND state NOT IN ('sent','send_failed','suppressed','skipped','no_proof','failed','terminal')
      ORDER BY last_polled_at NULLS FIRST, created_at
      LIMIT $1`, [limit]);
    return rows;
}
export async function listMatchRunsAwaitingApprovalPush(limit: number, client?: Q): Promise<Array<MatchRunRow & {
    approved_by: string | null;
}>> {
    const { rows } = await q(client).query<MatchRunRow & {
        approved_by: string | null;
    }>(`SELECT m.id, m.prospect_ref, m.requested_by_prospect_id, m.company_key, m.company_name,
            m.company_domain, m.campaign_key, m.state, m.bridge_row_uuid, m.touch_id,
            m.match_count, m.potential_total_usd::TEXT, m.payload, m.rendered_subject,
            m.rendered_body, m.rendered_body_html, m.content_hash, m.failure_reason,
            m.created_at, m.seeded_at, m.fresh_until, m.last_polled_at, t.approved_by
       FROM match_run m
       JOIN touch t ON t.id = m.touch_id
      WHERE m.state = 'awaiting_approval'
        AND m.bridge_row_uuid IS NOT NULL
        AND m.content_hash IS NOT NULL
        AND t.status = 'approved'
      ORDER BY t.approved_at
      LIMIT $1`, [limit]);
    return rows;
}
export async function matchRunForTouch(touchId: number, client?: Q): Promise<(MatchRunRow & {
    approved_by: string | null;
}) | null> {
    const { rows } = await q(client).query<MatchRunRow & {
        approved_by: string | null;
    }>(`SELECT m.id, m.prospect_ref, m.requested_by_prospect_id, m.company_key, m.company_name,
            m.company_domain, m.campaign_key, m.state, m.bridge_row_uuid, m.touch_id,
            m.match_count, m.potential_total_usd::TEXT, m.payload, m.rendered_subject,
            m.rendered_body, m.rendered_body_html, m.content_hash, m.failure_reason,
            m.created_at, m.seeded_at, m.fresh_until, m.last_polled_at, t.approved_by
       FROM match_run m
       JOIN touch t ON t.id = m.touch_id
      WHERE m.touch_id = $1`, [touchId]);
    return rows[0] ?? null;
}
export async function matchRunsForTouches(touchIds: number[], client?: Q): Promise<Map<number, MatchRunRow>> {
    if (touchIds.length === 0)
        return new Map();
    const { rows } = await q(client).query<MatchRunRow>(`SELECT ${MATCH_RUN_COLUMNS} FROM match_run WHERE touch_id = ANY($1)`, [touchIds]);
    return new Map(rows.filter((r) => r.touch_id !== null).map((r) => [r.touch_id!, r]));
}
export async function listMatchRunsAwaitingSkipPush(limit: number, client?: Q): Promise<MatchRunRow[]> {
    const { rows } = await q(client).query<MatchRunRow>(`SELECT m.id, m.prospect_ref, m.requested_by_prospect_id, m.company_key, m.company_name,
            m.company_domain, m.campaign_key, m.state, m.bridge_row_uuid, m.touch_id,
            m.match_count, m.potential_total_usd::TEXT, m.payload, m.rendered_subject,
            m.rendered_body, m.rendered_body_html, m.content_hash, m.failure_reason,
            m.created_at, m.seeded_at, m.fresh_until, m.last_polled_at
       FROM match_run m
       JOIN touch t ON t.id = m.touch_id
      WHERE m.state IN ('awaiting_approval', 'match_ready')
        AND m.bridge_row_uuid IS NOT NULL
        AND t.status = 'skipped'
      ORDER BY t.skipped_at
      LIMIT $1`, [limit]);
    return rows;
}
export async function freshNoProofForCompany(companyKey: string, freshnessDays: number, client?: Q): Promise<MatchRunRow | null> {
    const { rows } = await q(client).query<MatchRunRow>(`SELECT ${MATCH_RUN_COLUMNS}
       FROM match_run
      WHERE company_key = $1
        AND state = 'no_proof'
        AND match_count = 0
        AND created_at > NOW() - ($2 || ' days')::INTERVAL
      ORDER BY created_at DESC
      LIMIT 1`, [companyKey, freshnessDays]);
    return rows[0] ?? null;
}
export async function seedsPushedToday(now = new Date(), client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        count: string;
    }>(`SELECT COUNT(*)::TEXT AS count FROM match_run
      WHERE seeded_at IS NOT NULL AND (seeded_at AT TIME ZONE 'UTC')::DATE = $1`, [utcDay(now)]);
    return Number(rows[0]?.count ?? 0);
}
export async function matchRunIndex(client?: Q): Promise<Map<string, {
    matchRunId: number;
    touchId: number | null;
    prospectId: number | null;
}>> {
    const { rows } = await q(client).query<{
        id: number;
        bridge_row_uuid: string;
        touch_id: number | null;
        requested_by_prospect_id: number | null;
    }>(`SELECT id, bridge_row_uuid, touch_id, requested_by_prospect_id
       FROM match_run WHERE bridge_row_uuid IS NOT NULL`);
    return new Map(rows.map((r) => [
        r.bridge_row_uuid,
        { matchRunId: r.id, touchId: r.touch_id, prospectId: r.requested_by_prospect_id },
    ]));
}
export async function insertEvent(input: {
    eventKey: string;
    touchId: number | null;
    prospectId: number | null;
    kind: string;
    channel: string | null;
    source: string;
    payload: unknown;
    occurredAt: Date;
}, client?: Q): Promise<boolean> {
    const { rowCount } = await q(client).query(`INSERT INTO event (event_key, touch_id, prospect_id, kind, channel, source, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_key) DO NOTHING`, [
        input.eventKey,
        input.touchId,
        input.prospectId,
        input.kind,
        input.channel,
        input.source,
        input.payload ? JSON.stringify(input.payload) : null,
        input.occurredAt,
    ]);
    return (rowCount ?? 0) > 0;
}
export async function addSuppression(input: {
    prospectId: number | null;
    alias: Alias;
    reason: string;
    source: string;
}, client?: Q): Promise<void> {
    const value = normalizeAlias(input.alias.kind, input.alias.value);
    if (!value)
        return;
    await q(client).query(`INSERT INTO suppression (prospect_id, alias_kind, alias_value, reason, source)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (alias_kind, alias_value) DO NOTHING`, [input.prospectId, input.alias.kind, value, input.reason, input.source]);
}
export async function isSuppressedOrPaused(prospectId: number, client?: Q): Promise<{
    blocked: boolean;
    reason: string;
}> {
    const { rows } = await q(client).query<{
        paused: boolean;
        state: string;
        suppressed: number;
    }>(`SELECT (p.sequence_paused_at IS NOT NULL) AS paused,
            p.state,
            (SELECT COUNT(*)::INT FROM suppression s
              WHERE s.prospect_id = p.id
                 OR (s.alias_kind, s.alias_value) IN (
                      SELECT a.alias_kind, a.alias_value FROM prospect_alias a WHERE a.prospect_id = p.id
                    )) AS suppressed
       FROM prospect p WHERE p.id = $1`, [prospectId]);
    const row = rows[0];
    if (!row)
        return { blocked: true, reason: 'prospect not found' };
    if (row.suppressed > 0)
        return { blocked: true, reason: 'prospect or an alias is suppressed' };
    if (row.paused)
        return { blocked: true, reason: 'sequence paused pending founder triage' };
    if (row.state === 'suppressed')
        return { blocked: true, reason: 'prospect state is suppressed' };
    return { blocked: false, reason: 'clear' };
}
export async function recordScrapeRun(input: {
    seedAccountId: number | null;
    postId: number | null;
    kind: string;
    actor: string;
    mode: string;
    resultsCount: number;
    newCount: number;
    costUsd: number;
    outcome: string;
    error: string | null;
}, client?: Q): Promise<void> {
    await q(client).query(`INSERT INTO scrape_run (seed_account_id, post_id, kind, actor, mode, results_count,
                             new_count, cost_usd, outcome, error, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())`, [
        input.seedAccountId,
        input.postId,
        input.kind,
        input.actor,
        input.mode,
        input.resultsCount,
        input.newCount,
        input.costUsd,
        input.outcome,
        input.error,
    ]);
}
export async function recordSpend(category: string, amountUsd: number, units: number, meta: unknown, client?: Q): Promise<void> {
    if (amountUsd === 0 && units === 0)
        return;
    await q(client).query(`INSERT INTO spend_ledger (day, category, amount_usd, units, meta)
     VALUES ((NOW() AT TIME ZONE 'UTC')::DATE, $1, $2, $3, $4)`, [category, amountUsd, units, meta ? JSON.stringify(meta) : null]);
}
export async function spendToday(category: string, now = new Date(), client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        total: string | null;
    }>(`SELECT SUM(amount_usd)::TEXT AS total FROM spend_ledger WHERE day = $1 AND category = $2`, [utcDay(now), category]);
    return Number(rows[0]?.total ?? 0);
}
export async function unitsToday(category: string, now = new Date(), client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        total: string | null;
    }>(`SELECT SUM(units)::TEXT AS total FROM spend_ledger WHERE day = $1 AND category = $2`, [utcDay(now), category]);
    return Number(rows[0]?.total ?? 0);
}
export async function openHold(input: {
    subjectKind: string;
    subjectId: number | null;
    stage: string;
    reason: string;
    detail?: unknown;
}, client?: Q): Promise<void> {
    await q(client).query(`INSERT INTO pipeline_hold (subject_kind, subject_id, stage, reason, detail)
     VALUES ($1,$2,$3,$4,$5)`, [
        input.subjectKind,
        input.subjectId,
        input.stage,
        input.reason,
        input.detail ? JSON.stringify(input.detail) : null,
    ]);
}
export interface OpenHoldRow {
    id: number;
    subject_kind: string;
    subject_id: number | null;
    stage: string;
    reason: string;
    detail: unknown;
    created_at: Date;
}
export async function listOpenHolds(opts: {
    stage?: string | null;
    olderThanHours?: number | null;
    limit?: number;
} = {}, client?: Q): Promise<OpenHoldRow[]> {
    const { rows } = await q(client).query<OpenHoldRow>(`SELECT id, subject_kind, subject_id, stage, reason, detail, created_at
       FROM pipeline_hold
      WHERE resolved_at IS NULL
        AND ($1::TEXT IS NULL OR stage = $1)
        AND ($2::NUMERIC IS NULL OR created_at < NOW() - ($2 || ' hours')::INTERVAL)
      ORDER BY created_at
      LIMIT $3`, [opts.stage ?? null, opts.olderThanHours ?? null, opts.limit ?? 5000]);
    return rows;
}
export async function applyHoldRelease(plan: {
    holdIds: number[];
    prospectIds: number[];
}, resolvedBy: string): Promise<{
    holdsResolved: number;
    prospectsRequeued: number;
}> {
    if (plan.holdIds.length === 0 && plan.prospectIds.length === 0) {
        return { holdsResolved: 0, prospectsRequeued: 0 };
    }
    return withTx(async (client) => {
        let prospectsRequeued = 0;
        if (plan.prospectIds.length > 0) {
            const { rowCount } = await client.query(`UPDATE prospect
            SET state = 'new', hold_reason = NULL, updated_at = NOW()
          WHERE id = ANY($1) AND state = 'held'`, [plan.prospectIds]);
            prospectsRequeued = rowCount ?? 0;
        }
        let holdsResolved = 0;
        if (plan.holdIds.length > 0) {
            const { rowCount } = await client.query(`UPDATE pipeline_hold
            SET resolved_at = NOW(), resolved_by = $2
          WHERE id = ANY($1) AND resolved_at IS NULL`, [plan.holdIds, resolvedBy]);
            holdsResolved = rowCount ?? 0;
        }
        return { holdsResolved, prospectsRequeued };
    });
}
export async function holdDepth(client?: Q): Promise<Array<{
    stage: string;
    count: number;
}>> {
    const { rows } = await q(client).query<{
        stage: string;
        count: string;
    }>(`SELECT stage, COUNT(*)::TEXT AS count FROM pipeline_hold WHERE resolved_at IS NULL GROUP BY stage`);
    return rows.map((r) => ({ stage: r.stage, count: Number(r.count) }));
}
export async function getLaneState<T>(key: string, fallback: T, client?: Q): Promise<T> {
    const { rows } = await q(client).query<{
        value: T;
    }>(`SELECT value FROM lane_state WHERE key = $1`, [
        key,
    ]);
    return rows[0]?.value ?? fallback;
}
export async function setLaneState(key: string, value: unknown, updatedBy: string, client?: Q): Promise<void> {
    await q(client).query(`INSERT INTO lane_state (key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                                     updated_at = NOW()`, [key, JSON.stringify(value), updatedBy]);
}
export async function getCursor(source: string, client?: Q): Promise<number> {
    const { rows } = await q(client).query<{
        last_sequence: string;
    }>(`SELECT last_sequence::TEXT FROM export_cursor WHERE source = $1`, [source]);
    return Number(rows[0]?.last_sequence ?? 0);
}
export async function advanceCursor(source: string, sequence: number, client?: Q): Promise<void> {
    await q(client).query(`INSERT INTO export_cursor (source, last_sequence, last_pulled_at, updated_at)
     VALUES ($1,$2,NOW(),NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_sequence = GREATEST(export_cursor.last_sequence, EXCLUDED.last_sequence),
       last_pulled_at = NOW(), updated_at = NOW()`, [source, sequence]);
}
