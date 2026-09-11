import { withTx } from '../../db/client.js';
export async function recoverDraftHolds(): Promise<number> {
    return withTx(async (client) => {
        const { rows } = await client.query<{
            subject_id: number;
        }>(`
      UPDATE pipeline_hold SET resolved_at=NOW(), resolved_by='draft-auto-recovery'
       WHERE stage='draft' AND subject_kind='prospect' AND resolved_at IS NULL AND reason='hold'
         AND detail->>'detail' ~ '^(transport|timeout|rate_limit):'
         AND created_at < NOW() - INTERVAL '1 hour'
      RETURNING subject_id`);
        const ids = [...new Set(rows.map(r => r.subject_id).filter(Boolean))];
        if (!ids.length)
            return 0;
        const result = await client.query(`
      UPDATE prospect p SET state=CASE WHEN EXISTS (
          SELECT 1 FROM touch t WHERE t.prospect_id=p.id AND t.status <> 'skipped'
        ) THEN 'drafted' ELSE 'scored' END, hold_reason=NULL, updated_at=NOW()
       WHERE p.id=ANY($1) AND p.state='held' AND p.canonical_prospect_id IS NULL
         AND p.sequence_paused_at IS NULL
         AND EXISTS (SELECT 1 FROM icp_assessment a WHERE a.prospect_id=p.id)
         AND NOT EXISTS (SELECT 1 FROM pipeline_hold h WHERE h.subject_kind='prospect'
           AND h.subject_id=p.id AND h.resolved_at IS NULL)`, [ids]);
        return result.rowCount ?? 0;
    });
}
