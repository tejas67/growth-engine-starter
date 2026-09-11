import { withTx } from '../../db/client.js';
export const outcomeKinds=['sent','positive_reply','negative_reply','meeting_booked'] as const;
export type OutcomeKind=typeof outcomeKinds[number];
export async function recordOutcome(touchId:number,kind:OutcomeKind,actor:string):Promise<void>{
  if(!Number.isSafeInteger(touchId)||!outcomeKinds.includes(kind))throw new Error('Invalid outcome.');
  await withTx(async client=>{
    const {rows:[row]}=await client.query("SELECT t.prospect_id,t.channel FROM touch t JOIN prospect p ON p.id=t.prospect_id JOIN dispatch_attempt d ON d.touch_id=t.id WHERE t.id=$1 AND NOT p.is_demo AND d.status='accepted' FOR UPDATE OF t",[touchId]);
    if(!row)throw new Error('Only a real lead accepted by HeyReach can have an outcome recorded.');
    await client.query("UPDATE touch SET status='sent',sent_at=COALESCE(sent_at,NOW()),dry_run=FALSE WHERE id=$1",[touchId]);
    const event=async(key:string,eventKind:string)=>client.query(`INSERT INTO event(event_key,touch_id,prospect_id,kind,channel,source,payload,occurred_at)
      VALUES($1,$2,$3,$4,$5,'dashboard',$6,NOW()) ON CONFLICT(event_key) DO UPDATE SET kind=EXCLUDED.kind,payload=EXCLUDED.payload`,[key,touchId,row.prospect_id,eventKind,row.channel,JSON.stringify({actor,manually_confirmed:true,timing:'time recorded; verify actual delivery time in HeyReach'})]);
    await event(`manual-sent:${touchId}`,'sent');
    if(kind.endsWith('_reply')){await event(`manual-reply:${touchId}`,'reply');await event(`manual-verdict:${touchId}`,kind);}
    if(kind==='meeting_booked')await event(`manual-meeting:${touchId}`,kind);
    if(kind!=='sent')await client.query('UPDATE prospect SET sequence_paused_at=COALESCE(sequence_paused_at,NOW()) WHERE id=$1',[row.prospect_id]);
  });
}
