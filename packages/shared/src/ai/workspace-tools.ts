import {sql,type Selectable} from 'kysely';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import {roleHasCapability} from '../memberships.js';
import {retentionVisibilityCutoff} from '../retention-policy.js';
import type {AiRunsTable} from '../schema.js';
import {ReadCall} from './tool-contracts.js';
type Run=Selectable<AiRunsTable>;
const text=(value:string|null,max=1200)=>({text:(value || '').slice(0,max),truncated:(value || '').length>max});
/** Static, parameterized read tools. There is no model-supplied SQL or arbitrary network target. */
export async function readWorkspace(row:Run,raw:unknown,signal:AbortSignal,allowed:(trx:TenantExecutor)=>Promise<boolean>){
 const call=ReadCall.parse(raw),cid=row.customer_id;
 const cutoff=['delivery_summary','read_campaign'].includes(call.tool)?await retentionVisibilityCutoff(cid):null;
 return withTenant(cid,async trx=>{
  await sql`set local statement_timeout='3000ms'`.execute(trx);signal.throwIfAborted();
  if(!await allowed(trx))throw new Error('read_unavailable');
  const member=await trx.selectFrom('memberships').select('role').where('customer_id','=',cid).where('user_id','=',row.user_id).where('scim_active','=',true).executeTakeFirst();
  const capability=call.tool==='domain_status'?'domains:manage':['delivery_summary','list_campaigns','read_campaign','list_audiences','read_audience'].includes(call.tool)?'logs:read':'send';
  if(!member || !roleHasCapability(member.role,capability))throw new Error('read_unavailable');
  let data:unknown;
  const nameQuery=call.query.toLowerCase();
  switch(call.tool){
   case 'workspace_overview':{
    const workspace=await trx.selectFrom('customers').select('name').where('id','=',cid).executeTakeFirst();
    const counts=await trx.selectFrom('templates').select(eb=>eb.fn.countAll<string>().as('templates')).where('customer_id','=',cid).executeTakeFirst();
    data={workspace:workspace?.name,templates:Number(counts?.templates || 0)};break;
   }
   case 'list_campaigns': data=await trx.selectFrom('customer_campaigns').select(['id','name','subject','status','updated_at']).where('customer_id','=',cid).where(sql<boolean>`strpos(lower(name),${nameQuery})>0`).orderBy('updated_at','desc').limit(5).execute();break;
   case 'read_campaign':{
    const campaign=await trx.selectFrom('customer_campaigns').select(['id','name','subject','status','campaign_type','template_id','audience_id','send_at','updated_at']).where('customer_id','=',cid).where('id','=',call.id!).executeTakeFirst();
    if(!campaign){data={unavailable:true};break;}
    const from=new Date(Math.max(Date.now()-call.days*86400000,cutoff?.getTime() || 0));
    const stats=await trx.selectFrom('messages').select([
      sql<number>`count(*)::int`.as('total'),sql<number>`count(*) filter(where status='delivered')::int`.as('delivered'),sql<number>`count(*) filter(where status='accepted')::int`.as('accepted'),
      sql<number>`count(*) filter(where status in ('queued','held','sending'))::int`.as('pending'),sql<number>`count(*) filter(where status in ('soft_bounced','hard_bounced'))::int`.as('bounced'),
      sql<number>`count(*) filter(where status='failed')::int`.as('failed'),sql<number>`count(*) filter(where opened_at is not null)::int`.as('observed_opens'),sql<number>`count(*) filter(where human_opened_at is not null)::int`.as('classified_human_opens'),sql<number>`count(*) filter(where first_clicked_at is not null)::int`.as('observed_clicks'),
    ]).where('customer_id','=',cid).where(sql<boolean>`metadata->>'campaign_id'=${call.id}`).where(sql<boolean>`queued_at>=${from}`).executeTakeFirst();
    data={...campaign,stats,from:from.toISOString(),scope:'Messages queued in this time window and still visible under retention. Queued/accepted do not mean delivered; observed tracking may include automated activity. No causal diagnosis or benchmark is supplied.'};break;
   }
   case 'list_templates':data=await trx.selectFrom('templates').select(['id','name','subject','revision','updated_at']).where('customer_id','=',cid).where(sql<boolean>`strpos(lower(name),${nameQuery})>0`).orderBy('updated_at','desc').limit(5).execute();break;
   case 'read_template':{
    const record=await trx.selectFrom('templates').select(['id','name','subject','text_body','html_body','revision','updated_at']).where('customer_id','=',cid).where('id','=',call.id!).executeTakeFirst();
    data=record?{id:record.id,name:record.name,subject:record.subject,revision:record.revision,updated_at:record.updated_at,...text(record.text_body || record.html_body?.replace(/<[^>]*>/g,' ') || '')}:{unavailable:true};break;
   }
   case 'list_workflows':data=await trx.selectFrom('workflows').select(['id','name','status','trigger_type','updated_at']).where('customer_id','=',cid).where(sql<boolean>`strpos(lower(name),${nameQuery})>0`).orderBy('updated_at','desc').limit(5).execute();break;
   case 'read_workflow':data=await trx.selectFrom('workflows').select(['id','name','status','description','trigger_type','updated_at']).where('customer_id','=',cid).where('id','=',call.id!).executeTakeFirst() || {unavailable:true};break;
   case 'read_audience':data=await trx.selectFrom('audience_collections').select(['id','kind','name','updated_at']).where('customer_id','=',cid).where('id','=',call.id!).executeTakeFirst() || {unavailable:true};break;
   case 'list_audiences':data=await trx.selectFrom('audience_collections').select(['id','kind','name','updated_at']).where('customer_id','=',cid).where(sql<boolean>`strpos(lower(name),${nameQuery})>0`).orderBy('updated_at','desc').limit(5).execute();break;
   case 'domain_status':{
    const totals=await trx.selectFrom('sending_domains').select([sql<number>`count(*)::int`.as('connected'),sql<number>`count(*) filter(where verified_at is not null)::int`.as('verified')]).where('customer_id','=',cid).executeTakeFirstOrThrow();
    const domains=await trx.selectFrom('sending_domains').select(['domain','verified_at','spf_verified','dkim_verified','dmarc_verified','dmarc_policy']).where('customer_id','=',cid).orderBy('created_at','desc').limit(20).execute();
    data={connected:totals.connected,verified:totals.verified,domains,truncated:totals.connected>domains.length,source:'All workspace sending-domain records. Connected counts include unverified domains; verified is a separate count.'};break;
   }
   case 'delivery_summary':{
    const start=new Date(Date.now()-call.days*86400000);if(cutoff && cutoff>start)start.setTime(cutoff.getTime());
    if(start.getUTCHours() || start.getUTCMinutes() || start.getUTCSeconds())start.setUTCDate(start.getUTCDate()+1);start.setUTCHours(0,0,0,0);
    const from=start.toISOString().slice(0,10),through=new Date().toISOString().slice(0,10);
    const totals=await trx.selectFrom('usage_daily').select(eb=>[eb.fn.sum<string>('sent').as('sent'),eb.fn.sum<string>('delivered').as('delivered'),eb.fn.sum<string>('bounced').as('bounced'),eb.fn.sum<string>('complained').as('complained')]).where('customer_id','=',cid).where('usage_date','>=',new Date(from)).where('usage_date','<=',new Date(through)).executeTakeFirst();
    data={source:'usage_daily calendar-day rollups',from,through,timezone:'UTC',sent:Number(totals?.sent || 0),delivered:Number(totals?.delivered || 0),bounced:Number(totals?.bounced || 0),complained:Number(totals?.complained || 0),note:'No open-rate, inbox-placement, campaign-specific attribution or causal diagnosis is supplied.'};break;
   }
   case 'search_history':{
    const records=await trx.selectFrom('ai_chat_messages as m').innerJoin('ai_chats as c','c.id','m.chat_id').select(['m.id','m.chat_id','m.seq','m.role','m.text','c.title']).where('m.customer_id','=',cid).where('c.customer_id','=',cid).where('c.user_id','=',row.user_id).where('c.expires_at','>',new Date()).where('m.status','=','completed').where(eb=>eb.or([eb('m.chat_id','!=',row.chat_id!),eb('m.seq','<',row.chat_seq!)])).where(sql<boolean>`strpos(lower(m.text),${nameQuery})>0`).orderBy('m.created_at','desc').limit(5).execute();
    data=records.map(r=>({...r,...text(r.text,350)}));break;
   }
   case 'read_history':{
    const record=await trx.selectFrom('ai_chat_messages as m').innerJoin('ai_chats as c','c.id','m.chat_id').select(['m.id','m.chat_id','m.seq','m.role','m.text','c.title']).where('m.customer_id','=',cid).where('c.customer_id','=',cid).where('c.user_id','=',row.user_id).where('c.expires_at','>',new Date()).where('m.id','=',call.id!).where('m.status','=','completed').where(eb=>eb.or([eb('m.chat_id','!=',row.chat_id!),eb('m.seq','<',row.chat_seq!)])).executeTakeFirst();
    data=record?{...record,...text(record.text,1500)}:{unavailable:true};break;
   }
  }
  signal.throwIfAborted();if(!await allowed(trx))throw new Error('read_unavailable');
  return {tool:call.tool,observed_at:new Date().toISOString(),data};
 });
}

/** Populate the original @ context menu using actual tenant records. */
export async function aiContextCatalog(cid:string){return withTenant(cid,async trx=>({groups:[
 {name:'Campaigns',kind:'campaign',items:await trx.selectFrom('customer_campaigns').select(['id','name','status as meta']).where('customer_id','=',cid).orderBy('updated_at','desc').limit(10).execute()},
 {name:'Templates',kind:'template',items:await trx.selectFrom('templates').select(['id','name','subject as meta']).where('customer_id','=',cid).orderBy('updated_at','desc').limit(10).execute()},
 {name:'Workflows',kind:'workflow',items:await trx.selectFrom('workflows').select(['id','name','status as meta']).where('customer_id','=',cid).orderBy('updated_at','desc').limit(10).execute()},
 {name:'Audiences',kind:'audience',items:await trx.selectFrom('audience_collections').select(['id','name','kind as meta']).where('customer_id','=',cid).orderBy('updated_at','desc').limit(10).execute()},
]}));}
