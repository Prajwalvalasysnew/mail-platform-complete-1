import {sql} from 'kysely';
import {z} from 'zod';
import type {TenantExecutor} from './tenant-context.js';

/** The segment rules the product supports (Audiences page, campaigns and the AI agent). */
export const SEGMENT_RULE_FIELDS=['Created','Opened any email','Clicked any email'] as const;
export const SEGMENT_RULE_OPS=['in last','not in last'] as const;
export const SEGMENT_RULE_WINDOWS=['7 days','30 days','60 days','90 days','120 days'] as const;
export const SegmentRule=z.object({field:z.enum(SEGMENT_RULE_FIELDS),op:z.enum(SEGMENT_RULE_OPS),val:z.enum(SEGMENT_RULE_WINDOWS)}).strict();
export type SegmentRule=z.infer<typeof SegmentRule>;

/** Contacts in a list, or matching every rule of a segment. */
export function audienceMembers(trx:TenantExecutor,cid:string,collection:{id?:string;kind:'list'|'segment';rules:unknown}){
 let query=trx.selectFrom('audience_contacts as c').where('c.customer_id','=',cid);
 if(collection.kind==='list')query=query.where(eb=>eb.exists(eb.selectFrom('audience_collection_members as m').select('m.contact_id').whereRef('m.contact_id','=','c.id').where('m.customer_id','=',cid).where('m.collection_id','=',collection.id!)));
 else for(const rule of z.array(SegmentRule).parse(collection.rules)){
   const days=Number(rule.val.split(' ')[0]),since=new Date(Date.now()-days*86400000);
   if(rule.field==='Created')query=query.where('c.created_at',rule.op==='in last'?'>=':'<',since);
   else query=query.where(sql<boolean>`${rule.op==='not in last'?sql`NOT`:sql``} EXISTS (SELECT 1 FROM messages m JOIN events e ON e.customer_id=m.customer_id AND e.message_id=m.message_id WHERE m.customer_id=${cid} AND m.to_address=c.email AND e.event_type=${rule.field==='Opened any email'?'opened':'clicked'} AND e.occurred_at>=${since})`);
 }
 return query;
}

/** Members who may receive marketing email: subscribed with confirmed consent. */
export function sendableAudienceMembers(trx:TenantExecutor,cid:string,collection:{id?:string;kind:'list'|'segment';rules:unknown}){
 return audienceMembers(trx,cid,collection).where('c.status','=','Subscribed').where('c.consent_confirmed_at','is not',null);
}

/** Total and sendable member counts, for previews before anything is saved. */
export async function audienceCounts(trx:TenantExecutor,cid:string,collection:{id?:string;kind:'list'|'segment';rules:unknown}){
 const all=await audienceMembers(trx,cid,collection).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
 const sendable=await sendableAudienceMembers(trx,cid,collection).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
 return {matching:all.n,sendable:sendable.n};
}
