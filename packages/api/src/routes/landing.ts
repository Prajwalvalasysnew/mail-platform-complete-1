import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {db,randomToken,hashUserToken,hashRequestBody,recordAuditSafe} from '@platform/shared';
import {requireUser} from '../plugins/session-auth.js';
const Code=z.object({code:z.string().regex(/^vmh_[A-Za-z0-9_-]{43}$/)}).strict();
export const landingRoutes:FastifyPluginAsync=async app=>{
 app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');return payload;});
 app.post('/auth/handoff',{preHandler:requireUser,config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
  const parsed=z.object({destination:z.enum(['workspace','onboarding'])}).strict().safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'validation_failed'});
  const code=randomToken('vmh_',32),expires_at=new Date(Date.now()+60000);
  await db.insertInto('workspace_handoffs').values({code_hash:hashUserToken(code),session_id:req.user!.session_id,destination:parsed.data.destination,expires_at}).onConflict(oc=>oc.column('session_id').doUpdateSet({code_hash:hashUserToken(code),destination:parsed.data.destination,expires_at,created_at:new Date()})).execute();
  // Expired tickets are useless; opportunistic cleanup never touches sessions.
  void db.deleteFrom('workspace_handoffs').where('expires_at','<',new Date()).execute().catch(()=>{});
  return {code,expires_at};
 });
 app.post('/auth/handoff/inspect',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
  const parsed=Code.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'validation_failed'});
  const row=await db.selectFrom('workspace_handoffs as h').innerJoin('user_sessions as s','s.id','h.session_id').innerJoin('users as u','u.id','s.user_id').select(['u.email','h.destination']).where('h.code_hash','=',hashUserToken(parsed.data.code)).where('h.expires_at','>',new Date()).where('s.expires_at','>',new Date()).where('s.revoked_at','is',null).where('u.status','=','active').executeTakeFirst();
  return row || reply.code(410).send({error:'invalid_handoff',message:'This sign-in link expired or is no longer valid. Sign in again.'});
 });
 app.post('/auth/handoff/redeem',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
  const parsed=Code.extend({confirmed:z.literal(true)}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'validation_failed'});
  const outcome=await db.transaction().execute(async trx=>{
   const ticket=await trx.selectFrom('workspace_handoffs').selectAll().where('code_hash','=',hashUserToken(parsed.data.code)).forUpdate().executeTakeFirst();
   if(!ticket || new Date(ticket.expires_at).getTime()<=Date.now())return null;
   // Lock the source session too: logout/password reset/revocation cannot be
   // ignored by a ticket that was issued before that change. Never elevate MFA.
   const session=await trx.selectFrom('user_sessions').selectAll().where('id','=',ticket.session_id).forUpdate().executeTakeFirst();
   const user=session?await trx.selectFrom('users').select(['status','mfa_enabled']).where('id','=',session.user_id).forUpdate().executeTakeFirst():null;
   if(!session || session.revoked_at || new Date(session.expires_at).getTime()<=Date.now() || user?.status!=='active'){await trx.deleteFrom('workspace_handoffs').where('code_hash','=',ticket.code_hash).execute();return null;}
   const token=randomToken('mpu_',32);
   // Rotate, do not duplicate, the authenticated session. Original bearer and
   // all handoff tickets stop working atomically with the single-use claim.
   await trx.updateTable('user_sessions').set({token_hash:hashUserToken(token),ip:req.ip,user_agent:req.headers['user-agent'] || null,last_seen_at:new Date()}).where('id','=',session.id).execute();
   await trx.deleteFrom('workspace_handoffs').where('session_id','=',session.id).execute();
   return {token,mfa_required:!!user.mfa_enabled && !session.mfa_satisfied,destination:ticket.destination};
  });
  return outcome || reply.code(410).send({error:'invalid_handoff',message:'This sign-in link expired, was revoked or was already used. Sign in again.'});
 });
 app.post('/landing/sales-requests',{config:{rateLimit:{max:5,timeWindow:'1 hour'}}},async(req,reply)=>{
  const parsed=z.object({request_id:z.string().uuid(),first_name:z.string().trim().min(1).max(100),last_name:z.string().trim().max(100).default(''),email:z.string().email().max(320).transform(value=>value.toLowerCase()),company:z.string().trim().min(1).max(200),monthly_volume:z.enum(['Under 100,000','100,000 – 1M','1M – 10M','10M – 50M','50M+']),message:z.string().trim().max(4000).default(''),consent_confirmed:z.literal(true)}).strict().safeParse(req.body);
  if(!parsed.success)return reply.code(400).send({error:'validation_failed',message:'Check the form fields and consent before submitting.'});
  const {request_id,consent_confirmed,...data}=parsed.data,request_hash=hashRequestBody(data);
  const saved=await db.insertInto('landing_sales_requests').values({id:request_id,request_hash,...data}).onConflict(oc=>oc.column('id').doNothing()).returning('id').executeTakeFirst();
  if(!saved){const existing=await db.selectFrom('landing_sales_requests').select('request_hash').where('id','=',request_id).executeTakeFirst();if(existing?.request_hash!==request_hash)return reply.code(409).send({error:'request_changed',message:'This request ID was already used with different fields. Reload the form before sending another request.'});}
  if(saved)recordAuditSafe({actorType:'system',action:'landing.sales_request.created',resource:request_id,metadata:{source:'website'}});
  return reply.code(saved?201:200).send({id:request_id,status:'received',replayed:!saved});
 });
};
