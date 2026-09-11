import { withTx } from '../../db/client.js';
export async function refreshDrafts(version: string, apply = false): Promise<{
    eligible: number;
    retired: number;
    requeued: number;
}> {
    if (!/^v\d+$/.test(version))
        throw new Error('Expected a copywriter version such as v8');
    return withTx(async (client) => {
        const { rows } = await client.query<{
            id: number;
            prospect_id: number;
            template_version: string;
        }>(`
      SELECT t.id,t.prospect_id,t.template_version FROM touch t JOIN prospect p ON p.id=t.prospect_id
       WHERE t.status='draft' AND NOT t.founder_edited
         AND t.approved_at IS NULL AND t.sent_at IS NULL AND t.match_run_id IS NULL
         AND t.channel IN ('dm','connect')
         AND t.template_version ~ '^(A-hw|B-intro)@v[0-9]+(-[a-zA-Z0-9_-]+)?$'
         AND substring(t.template_version from '@v([0-9]+)')::integer < $1
         AND p.state='drafted' AND p.canonical_prospect_id IS NULL AND p.sequence_paused_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM pipeline_hold h WHERE h.subject_kind='prospect'
           AND h.subject_id=p.id AND h.resolved_at IS NULL)
       ORDER BY t.id FOR UPDATE OF t,p`, [Number(version.slice(1))]);
        if (!apply || rows.length === 0)
            return { eligible: rows.length, retired: 0, requeued: 0 };
        const ids = rows.map(r => r.id);
        await client.query(`UPDATE touch SET status='skipped',skipped_at=NOW(),failure_reason=$2 WHERE id=ANY($1)`, [ids, `Replaced by copywriter ${version}`]);
        await client.query(`INSERT INTO approval_audit(touch_id,actor,action,detail)
      SELECT id,'copywriter-refresh','skip',jsonb_build_object('reason','copywriter upgrade','from',template_version,'to',$2::text)
        FROM touch WHERE id=ANY($1)`, [ids, version]);
        const result = await client.query(`UPDATE prospect p SET state='scored',hold_reason=NULL,updated_at=NOW()
      WHERE p.id=ANY($1) AND NOT EXISTS (SELECT 1 FROM touch t WHERE t.prospect_id=p.id AND t.status<>'skipped')`, [[...new Set(rows.map(r => r.prospect_id))]]);
        return { eligible: rows.length, retired: rows.length, requeued: result.rowCount ?? 0 };
    });
}
