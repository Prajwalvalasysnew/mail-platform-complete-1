import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {sql} from 'kysely';
import {randomUUID} from 'node:crypto';
import {renderTemplate,MissingTemplateVariablesError,recordAuditSafe,hashRequestBody} from '@platform/shared';
import {tenantScoped} from '../lib/tenant.js';
import {audienceMembers} from './customer-audiences.js';
import {subjectTestPayload,frozenRecipients,frozenLaunchId,batchCampaignResult} from '../lib/campaign-subject-test.js';

const Id=z.string().uuid(),header=z.string().max(998).regex(/^[^\r\n\0]*$/);
const Draft=z.object({name:z.string().trim().min(1).max(200),audience_id:Id.nullable(),template_id:Id.nullable(),from_email:header,from_name:header.max(100),reply_to:header,subject:header,subject_b:header.default(''),send_at:z.string().datetime().nullable().default(null)}).strict();
const fields=['id','name','audience_id','template_id','from_email','from_name','reply_to','subject','subject_b','campaign_type','send_at','revision','status','result','created_at','updated_at'] as const;
class CampaignError extends Error {constructor(public code:string,public status:number,message:string){super(message);}}
export const customerCampaignRoutes:FastifyPluginAsync=async app=>{
 app.get('/campaigns',async req=>tenantScoped(req,async trx=>{
  const campaigns=await trx.selectFrom('customer_campaigns').select([...fields]).where('customer_id','=',req.auth!.customer_id).orderBy('created_at','desc').limit(200).execute();
  // Message status is authoritative; queued does not mean delivered.
  const stats=campaigns.length?await trx.selectFrom('messages').select([
   sql<string>`metadata->>'campaign_id'`.as('campaign_id'),sql<number>`count(*)::int`.as('total'),
   sql<number>`count(*) FILTER(WHERE status='delivered')::int`.as('delivered'),
   sql<number>`count(*) FILTER(WHERE opened_at IS NOT NULL)::int`.as('opened'),
   sql<number>`count(*) FILTER(WHERE first_clicked_at IS NOT NULL)::int`.as('clicked'),
   sql<number>`count(*) FILTER(WHERE status IN ('queued','held','sending','soft_bounced'))::int`.as('pending')
  ]).where('customer_id','=',req.auth!.customer_id).where(sql<boolean>`metadata->>'campaign_id'=ANY(${campaigns.map(row=>row.id)}::text[])`).groupBy(sql`metadata->>'campaign_id'`).execute():[];
  const variants=campaigns.length?await trx.selectFrom('messages').select([sql<string>`metadata->>'campaign_id'`.as('campaign_id'),sql<string>`metadata->>'campaign_variant'`.as('variant'),sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE status='delivered')::int`.as('delivered'),sql<number>`count(*) FILTER(WHERE opened_at IS NOT NULL)::int`.as('opened'),sql<number>`count(*) FILTER(WHERE first_clicked_at IS NOT NULL)::int`.as('clicked')]).where('customer_id','=',req.auth!.customer_id).where(sql<boolean>`metadata->>'campaign_id'=ANY(${campaigns.map(row=>row.id)}::text[]) AND metadata->>'campaign_variant' IN ('A','B')`).groupBy([sql`metadata->>'campaign_id'`,sql`metadata->>'campaign_variant'`]).execute():[];
  return {campaigns:campaigns.map(row=>({...row,variants:variants.filter(stat=>stat.campaign_id===row.id),stats:stats.find(stat=>stat.campaign_id===row.id)||{total:0,delivered:0,opened:0,clicked:0,pending:0}}))};
 }));
 app.post('/campaigns',async(req,reply)=>{
  const body=z.object({name:z.string().trim().min(1).max(200),audience_id:Id.nullable().default(null),campaign_type:z.enum(['regular','ab_subject']).default('regular')}).strict().safeParse(req.body);if(!body.success)return reply.code(400).send({error:'validation_failed'});
  const row=await tenantScoped(req,async trx=>{
   if(body.data.audience_id && !await trx.selectFrom('audience_collections').select('id').where('customer_id','=',req.auth!.customer_id).where('id','=',body.data.audience_id).executeTakeFirst())return null;
   return trx.insertInto('customer_campaigns').values({customer_id:req.auth!.customer_id,...body.data,template_id:null,snapshot:null,result:null,send_at:null}).returning([...fields]).executeTakeFirstOrThrow();
  });return row?reply.code(201).send(row):reply.code(404).send({error:'audience_not_found'});
 });
 app.put('/campaigns/:id',async(req,reply)=>{
  const id=Id.safeParse((req.params as any).id),body=Draft.extend({expected_revision:z.number().int().min(0)}).safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed'});
  const {expected_revision,...draft}=body.data;
  const row=await tenantScoped(req,async trx=>{
   for(const [table,key] of [['audience_collections',draft.audience_id],['templates',draft.template_id]] as const)if(key && !await trx.selectFrom(table).select('id').where('customer_id','=',req.auth!.customer_id).where('id','=',key).executeTakeFirst())return null;
   return trx.updateTable('customer_campaigns').set({...draft,revision:sql`revision+1`,updated_at:new Date()}).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).where('revision','=',expected_revision).where('status','=','draft').returning([...fields]).executeTakeFirst();
  });return row || reply.code(409).send({error:'stale_revision',message:'The draft changed, is unavailable, or a selected resource was removed. Reload before editing.'});
 });
 app.post('/campaigns/:id/cancel',async(req,reply)=>{
  const id=Id.safeParse((req.params as any).id),body=z.object({expected_revision:z.number().int().min(0)}).strict().safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed'});
  const row=await tenantScoped(req,trx=>trx.updateTable('customer_campaigns').set({status:'cancelled',revision:sql`revision+1`,updated_at:new Date()}).where('id','=',id.data).where('customer_id','=',req.auth!.customer_id).where('revision','=',body.data.expected_revision).where('status','=','draft').returning([...fields]).executeTakeFirst());
  return row || reply.code(409).send({error:'invalid_state',message:'Only an unchanged draft can be cancelled. Queued mail cannot be recalled here.'});
 });
 app.post('/campaigns/:id/reconcile',async(req,reply)=>{
  const id=Id.safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'validation_failed'});
  const outcome=await tenantScoped(req,async trx=>{
   const row=await trx.selectFrom('customer_campaigns').selectAll().where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).forUpdate().executeTakeFirst();
   if(!row)return {code:404,body:{error:'not_found'}};
   if(row.status!=='dispatching')return {code:200,body:{status:row.status,result:row.result,reconciled:false}};
   if(Date.now()-new Date(row.updated_at).getTime()<30000)return {code:409,body:{error:'launch_in_progress',message:'The launch may still be running. Wait at least 30 seconds before checking recovery.'}};
   const snapshot=row.snapshot as any;
   const recipients=frozenRecipients(snapshot),launchId=frozenLaunchId(snapshot);
   if(!recipients)return {code:409,body:{error:'unresolved_launch',message:'No valid frozen request exists. No send was retried.'}};
   const recorded=await trx.selectFrom('idempotency_keys').select(['request_hash','status_code','response_body']).where('customer_id','=',req.auth!.customer_id).where('idempotency_key','=',`campaign-${id.data}`).executeTakeFirst();
   let status:'queued'|'failed'|undefined,result:any;
   if(recorded?.request_hash===hashRequestBody(snapshot) && recorded.status_code===202){status='queued';result=recorded.response_body;}
   else if(recorded?.request_hash===hashRequestBody(snapshot) && recorded.status_code && recorded.status_code>=400 && recorded.status_code<500 && recorded.status_code!==409){status='failed';result=recorded.response_body;}
   else if(launchId){
    const messages=await trx.selectFrom('messages').select(['message_id','to_address']).where('customer_id','=',req.auth!.customer_id).where(sql<boolean>`metadata->>'campaign_id'=${id.data} AND metadata->>'campaign_launch_id'=${launchId}`).execute();
    // This send endpoint commits its batch atomically. The nonce is private to
    // the frozen request; campaign_id alone is not sufficient recovery proof.
    if(messages.length && messages.length<=recipients.length && messages.every(message=>recipients.includes(message.to_address))){status='queued';result={accepted:messages.length,message_ids:messages.map(message=>message.message_id),recovered_from:'committed_messages',outcomes_unknown:!!snapshot.messages,message: snapshot.messages?'Accepted messages recovered. Per-recipient rejection/suppression details were not recovered; no recipients were resent.':undefined};}
   }
   if(!status)return {code:409,body:{error:'unresolved_launch',message:'No conclusive send result exists. Nothing was resent. Inspect Messages before taking further action.'}};
   await trx.updateTable('customer_campaigns').set({status,result,revision:sql`revision+1`,updated_at:new Date()}).where('id','=',id.data).where('customer_id','=',req.auth!.customer_id).execute();
   return {code:200,body:{status,result,reconciled:true}};
  });
  if((outcome.body as any).reconciled)recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'campaign.reconciled',resource:id.data});
  return reply.code(outcome.code).send(outcome.body);
 });
 app.post('/campaigns/:id/cancel-scheduled',async(req,reply)=>{
  const id=Id.safeParse((req.params as any).id),body=z.object({expected_revision:z.number().int().min(0)}).strict().safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed'});
  const row=await tenantScoped(req,trx=>trx.selectFrom('customer_campaigns').selectAll().where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).executeTakeFirst());
  if(!row)return reply.code(404).send({error:'not_found'});
  if(row.status==='cancelled')return {status:'cancelled',already_cancelled:true};
  if(row.status!=='queued' || row.revision!==body.data.expected_revision || !row.send_at || new Date(row.send_at).getTime()<=Date.now())return reply.code(409).send({error:'not_cancellable',message:'Only a future scheduled campaign with the current revision can be cancelled. Mail already dispatched cannot be recalled.'});
  const ids=(row.result as any)?.message_ids;
  if(!Array.isArray(ids) || ids.length>200 || ids.some(id=>typeof id!=='string'))return reply.code(409).send({error:'unresolved_launch',message:'Recover the launch result before cancelling its messages.'});
  const messages=ids.length?await tenantScoped(req,trx=>trx.selectFrom('messages').select(['message_id','failure_reason']).where('customer_id','=',req.auth!.customer_id).where('message_id','in',ids).where(sql<boolean>`metadata->>'campaign_id'=${id.data}`).execute()):[];
  if(messages.length!==ids.length)return reply.code(409).send({error:'missing_messages',message:'Some launch records are missing. No cancellation was attempted.'});
  let cancelled=0;const notCancelled:string[]=[];
  for(const message of messages){
   if(message.failure_reason==='cancelled_by_user'){cancelled++;continue;}
   const response=await app.inject({method:'DELETE',url:`/v1/account/data/messages/${encodeURIComponent(message.message_id)}/cancel`,headers:{authorization:req.headers.authorization!}});
   if(response.statusCode===200)cancelled++;else notCancelled.push(message.message_id);
  }
  if(!notCancelled.length)await tenantScoped(req,trx=>trx.updateTable('customer_campaigns').set({status:'cancelled',revision:sql`revision+1`,updated_at:new Date()}).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).where('status','=','queued').execute());
  recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'campaign.schedule_cancelled',resource:id.data,metadata:{cancelled,not_cancelled:notCancelled.length}});
  return {status:notCancelled.length?'queued':'cancelled',cancelled,not_cancelled:notCancelled,partial:notCancelled.length>0,message:notCancelled.length?'Some messages were already dispatched or could not be cancelled. Inspect their actual status.':'The pending scheduled messages were cancelled.'};
 });
 app.post('/campaigns/:id/launch',async(req,reply)=>{
  const id=Id.safeParse((req.params as any).id),body=z.object({expected_revision:z.number().int().min(0),ad_identified:z.literal(true)}).strict().safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed',message:'Confirm the advertisement identification attestation before sending.'});
  try{
   const claimed=await tenantScoped(req,async trx=>{
    const row=await trx.selectFrom('customer_campaigns').selectAll().where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).forUpdate().executeTakeFirst();if(!row)throw new CampaignError('not_found',404,'Campaign not found.');
    if(row.status!=='draft')return {existing:row};
    if(row.revision!==body.data.expected_revision)throw new CampaignError('stale_revision',409,'Reload the latest campaign before sending.');
    if(!z.string().email().safeParse(row.from_email).success || !row.template_id || !row.subject.trim())throw new CampaignError('incomplete_campaign',422,'Choose a saved template, valid sender and subject.');
    if(row.reply_to && !z.string().email().safeParse(row.reply_to).success)throw new CampaignError('invalid_reply_to',422,'Enter a valid reply-to email.');
    if(row.campaign_type==='ab_subject' && (!row.subject_b.trim() || row.subject_b.trim()===row.subject.trim()))throw new CampaignError('invalid_subject_test',422,'Enter two different, non-empty subject lines. This is a fixed 50/50 subject test, not automatic winner selection.');
    if(row.send_at && (new Date(row.send_at).getTime()<Date.now()+300000 || new Date(row.send_at).getTime()>Date.now()+90*86400000))throw new CampaignError('invalid_schedule',422,'Schedule between five minutes and 90 days from now.');
    let audience=trx.selectFrom('audience_contacts as c').where('c.customer_id','=',req.auth!.customer_id);
    if(row.audience_id){const collection=await trx.selectFrom('audience_collections').selectAll().where('id','=',row.audience_id).where('customer_id','=',req.auth!.customer_id).executeTakeFirst();if(!collection)throw new CampaignError('audience_not_found',422,'The selected audience was removed.');audience=audienceMembers(trx,req.auth!.customer_id,collection);}
    const contacts=await audience.where('c.status','=','Subscribed').where('c.consent_confirmed_at','is not',null).select('c.email').orderBy('c.id').limit(201).execute();
    if(!contacts.length)throw new CampaignError('empty_audience',422,'No consent-confirmed subscribers match this audience.');
    if(contacts.length>200)throw new CampaignError('audience_too_large',422,'This one-off campaign implementation supports at most 200 subscribers. No partial audience was sent.');
    if(row.campaign_type==='ab_subject' && (contacts.length<2 || contacts.length>100))throw new CampaignError('invalid_test_audience',422,'Subject A/B tests require between 2 and 100 consent-confirmed subscribers. No partial audience was sent.');
    const template=await trx.selectFrom('templates').selectAll().where('customer_id','=',req.auth!.customer_id).where('id','=',row.template_id).executeTakeFirst();if(!template)throw new CampaignError('template_not_found',422,'The selected template was removed.');
    const rendered=renderTemplate(template,{}, {onMissing:'error'});
    const base=JSON.parse(JSON.stringify({from:row.from_email,...(row.from_name?{from_name:row.from_name}:{}),...(row.reply_to?{reply_to:row.reply_to}:{}),subject:row.subject,html:rendered.html,text:rendered.text,to:contacts.map(contact=>contact.email),metadata:{campaign_id:row.id,campaign_launch_id:randomUUID()},message_class:'commercial',ip_pool:'marketing',ad_identified:true,...(row.send_at?{send_at:new Date(row.send_at).toISOString()}:{})}));
    const payload=row.campaign_type==='ab_subject'?subjectTestPayload(base,row.subject_b):base;
    if(row.campaign_type==='ab_subject' && Buffer.byteLength(JSON.stringify(payload),'utf8')>900000)throw new CampaignError('test_payload_too_large',422,'This subject test exceeds the batch request budget. Use a smaller saved template or audience. Nothing was sent.');
    await trx.updateTable('customer_campaigns').set({status:'dispatching',snapshot:payload,revision:sql`revision+1`,updated_at:new Date()}).where('id','=',row.id).where('customer_id','=',req.auth!.customer_id).execute();return {payload};
   });
   if('existing' in claimed)return reply.code(claimed.existing!.status==='queued'?200:409).send({status:claimed.existing!.status,result:claimed.existing!.result,message:'This launch was already claimed. It will not be sent again. Check Messages if its outcome is uncertain.'});
   // The existing send route retains account/domain/consent/compliance/quota,
   // content screening, durable outbox and worker safeguards. Never bypass it.
   // A claimed campaign is never automatically re-dispatched after a crash:
   // uncertain outcomes fail closed rather than risking duplicate broadcasts.
   const batch=!!claimed.payload.messages;
   const response=await app.inject({method:'POST',url:batch?'/v1/account/data/send/batch':'/v1/account/data/send',headers:{authorization:req.headers.authorization!,'idempotency-key':`campaign-${id.data}`},payload:claimed.payload});
   const rawResult=response.json(),result=batch && response.statusCode===202?batchCampaignResult(rawResult):rawResult,status=response.statusCode===202 && (!batch || result.accepted>0)?'queued':'failed';
   if(batch && response.statusCode===202 && !result.accepted){result.error='no_recipients_accepted';result.message='The send service accepted no recipients. Review the recorded per-recipient outcomes; nothing will be retried automatically.';}
   await tenantScoped(req,trx=>trx.updateTable('customer_campaigns').set({status,result,updated_at:new Date()}).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).where('status','=','dispatching').execute());
   recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:`campaign.${status}`,resource:id.data});
   return reply.code(status==='failed' && response.statusCode===202?422:response.statusCode).send({status,result,...(status==='failed'?{error:result.error,message:result.message || 'Sending was refused by the delivery service. Inspect this campaign before creating a replacement.'}:{})});
  }catch(error){if(error instanceof CampaignError)return reply.code(error.status).send({error:error.code,message:error.message});if(error instanceof MissingTemplateVariablesError)return reply.code(422).send({error:'missing_template_variables',message:'Personalized templates require variables; use a complete non-personalized template for this one-off campaign.',missing:error.missing});throw error;}
 });
};
