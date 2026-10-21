import { randomUUID, createHash } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { AiRunsTable } from '../schema.js';
import { db } from '../db.js';
import { withTenant, type TenantExecutor } from '../tenant-context.js';
import { roleHasCapability } from '../memberships.js';
import { scanContent } from '../abuse.js';
import { classify } from '../classifier.js';
import { aiConfig, aiEnabledFor, aiInputByteLimit } from './config.js';
import { AiInput, type AiOutput } from './contracts.js';
import { generateAi,AiContextOverflowError,AiProviderUnavailableError,AiOutputValidationError } from './provider.js';
import {groundAiRequest,needsWorkspace,attachWorkspaceEvidence} from './agent.js';
import { prepareChatContext } from './chat-context.js';

export class AiRunError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
type Run = Selectable<AiRunsTable>;

/** Public data only: no prompts, host, credentials, model IDs or session IDs. */
export function publicAiRun(row: Run) {
  return { id: row.id, status: row.status, result: row.result, warnings: Array.isArray(row.warnings)?row.warnings.filter((w):w is string=>typeof w==='string'):[], error: row.error,
    created_at: row.created_at, expires_at: row.expires_at };
}

/** Verify the original human authority remains valid, including revocation and MFA. */
export async function aiActorAllowed(trx: TenantExecutor, row: Pick<Run, 'customer_id'|'user_id'|'session_id'>): Promise<boolean> {
  if (!row.session_id || !aiEnabledFor(row.customer_id)) return false;
  const actor = await trx.selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('user_sessions as s', 's.user_id', 'u.id')
    .innerJoin('customers as c', 'c.id', 'm.customer_id')
    .select(['m.role','u.mfa_enabled','s.mfa_satisfied'])
    .where('m.customer_id','=',row.customer_id).where('m.user_id','=',row.user_id).where('m.scim_active','=',true)
    .where('s.id','=',row.session_id).where('s.current_customer_id','=',row.customer_id)
    .where('s.revoked_at','is',null).where('s.expires_at','>',new Date())
    .where('u.status','=','active').where('c.status','=','active').executeTakeFirst();
  return !!actor && roleHasCapability(actor.role,'send') && (!actor.mfa_enabled || actor.mfa_satisfied);
}

/** Commit durable dispatch intent. Database serialization enforces per-user limits. */
export async function createAiRun(customerId:string,userId:string,sessionId:string,requestId:string,input:AiInput,chat?:{trx:TenantExecutor;id:string;seq:number}) {
  const c=aiConfig(),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>aiInputByteLimit(input.operation,c))throw new AiRunError('ai_context_limit',400,'This text is too long for the configured AI context. Use a shorter selection or writing brief.');
  const admit=async(trx:TenantExecutor)=>{
    await sql`select pg_advisory_xact_lock(hashtextextended(${customerId+':'+userId+':ai'},0))`.execute(trx);
    if(!await aiActorAllowed(trx,{customer_id:customerId,user_id:userId,session_id:sessionId}))throw new AiRunError('ai_unavailable',403,'Valasys AI is not enabled for this workspace or role.');
    const previous=await trx.selectFrom('ai_runs').selectAll().where('customer_id','=',customerId).where('user_id','=',userId).where('request_id','=',requestId).executeTakeFirst();
    if(previous){
      if(previous.request_hash!==hash)throw new AiRunError('request_conflict',409,'This request ID was already used for different content.');
      if(previous.expires_at<=new Date())throw new AiRunError('run_expired',410,'This result has expired. Start a new request.');
      return publicAiRun(previous);
    }
    const recent=await trx.selectFrom('ai_runs').select(['status','deadline']).where('customer_id','=',customerId).where('user_id','=',userId).where('created_at','>',new Date(Date.now()-86400000)).execute();
    if(recent.length>=c.dailyLimit)throw new AiRunError('ai_limit',429,'Your daily AI writing limit has been reached.');
    if(recent.some(r=>['queued','running'].includes(r.status) && r.deadline>new Date()))throw new AiRunError('ai_busy',409,'Finish or stop your current AI request first.');
    const row=await trx.insertInto('ai_runs').values({id:randomUUID(),customer_id:customerId,user_id:userId,session_id:sessionId,request_id:requestId,request_hash:hash,input,
      deadline:new Date(Date.now()+c.timeoutMs+30000),expires_at:new Date(Date.now()+c.retentionHours*3600000),model:c.model,...(chat?{chat_id:chat.id,chat_seq:chat.seq}:{})}).returningAll().executeTakeFirstOrThrow();
    return publicAiRun(row);
  };
  return chat?admit(chat.trx):withTenant(customerId,admit);
}

export async function getAiRun(customerId:string,userId:string,id:string) {
  return withTenant(customerId,async trx=>{
    const row=await trx.selectFrom('ai_runs').selectAll().where('customer_id','=',customerId).where('user_id','=',userId).where('id','=',id).where('expires_at','>',new Date()).executeTakeFirst();
    if(!row || !await aiActorAllowed(trx,row))return null;
    const steps=await trx.selectFrom('ai_run_steps').select(['name','status','created_at']).where('customer_id','=',customerId).where('run_id','=',id).where('attempt','=',row.attempt).orderBy('seq').limit(40).execute();
    return {...publicAiRun(row),steps};
  });
}

export async function cancelAiRun(customerId:string,userId:string,id:string) {
  return withTenant(customerId,async trx=>{
    await trx.updateTable('ai_runs').set({status:'cancelled',input:null,result:null,lease_until:null,updated_at:new Date()})
      .where('customer_id','=',customerId).where('user_id','=',userId).where('id','=',id).where('status','in',['queued','running']).execute();
    const row=await trx.selectFrom('ai_runs').selectAll().where('customer_id','=',customerId).where('user_id','=',userId).where('id','=',id).where('expires_at','>',new Date()).executeTakeFirst();
    if(row?.status==='cancelled' && row.chat_id)await trx.updateTable('ai_chat_messages').set({status:'cancelled',text:'Generation stopped.',result:null}).where('customer_id','=',customerId).where('run_id','=',id).where('role','=','assistant').execute();
    return row?publicAiRun(row):null;
  });
}

/** Worker invocation is at least once; only a current live attempt may commit a result. */
export async function executeAiRun(customerId:string,id:string,shutdown:AbortSignal) {
  const c=aiConfig();
  const row=await withTenant(customerId,async trx=>{
    const candidate=await trx.selectFrom('ai_runs').selectAll().where('customer_id','=',customerId).where('id','=',id).forUpdate().executeTakeFirst();
    if(!candidate || candidate.status!=='queued' || candidate.deadline<=new Date() || candidate.attempt>=2)return null;
    if(!await aiActorAllowed(trx,candidate)){
      await trx.updateTable('ai_runs').set({status:'failed',input:null,error:'Workspace access changed. Start a new request after signing in.',updated_at:new Date()}).where('id','=',id).where('customer_id','=',customerId).execute();return null;
    }
    return trx.updateTable('ai_runs').set({status:'running',attempt:candidate.attempt+1,lease_until:new Date(Date.now()+15000),updated_at:new Date()})
      .where('customer_id','=',customerId).where('id','=',id).returningAll().executeTakeFirstOrThrow();
  });
  if(!row)return;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,shutdown,AbortSignal.timeout(Math.max(1,row.deadline.getTime()-Date.now()))]);
  let checking=false;
  const timer=setInterval(()=>{
    if(checking)return;checking=true;
    void withTenant(customerId,async trx=>{
      if(!await aiActorAllowed(trx,row)){controller.abort();return;}
      const updated=await trx.updateTable('ai_runs').set({lease_until:new Date(Date.now()+15000)})
        .where('customer_id','=',customerId).where('id','=',id).where('attempt','=',row.attempt).where('status','=','running').where('deadline','>',new Date()).executeTakeFirst();
      if(!Number(updated.numUpdatedRows))controller.abort();
    }).catch(()=>controller.abort()).finally(()=>{checking=false;});
  },3000);
  try {
    const input=AiInput.parse(row.input);
    // Persisted model selection is authoritative for this run; a deployment switch must not silently change it.
    if(row.model!==c.model)throw new Error('Model configuration changed');
    let context=row.chat_id?await prepareChatContext(row,input,signal,async trx=>await aiActorAllowed(trx,row)):null;
    const grounding=row.chat_id && !context?.manual && needsWorkspace(context?.input || input)?await groundAiRequest(row,context?.input || input,signal,async trx=>await aiActorAllowed(trx,row)):null;
    let generated;
    try{generated=context?.manual?{result:{operation:'chat' as const,text:context.changed?'Earlier context has been compacted. Your full chat history is preserved.':'There is no older context to compact yet.'},promptTokens:0 as number|null,outputTokens:0 as number|null}:await generateAi(grounding?.input || context?.input || input,signal,fetch,{grounded:grounding?.grounded});}
    catch(error){
      if(!(error instanceof AiContextOverflowError) || !row.chat_id)throw error;
      const recovery=await prepareChatContext(row,input,signal,async trx=>await aiActorAllowed(trx,row),true);
      if(!recovery.changed)throw error;
      recovery.promptTokens=context?.promptTokens===null || recovery.promptTokens===null?null:(context?.promptTokens || 0)+recovery.promptTokens;
      recovery.outputTokens=context?.outputTokens===null || recovery.outputTokens===null?null:(context?.outputTokens || 0)+recovery.outputTokens;
      context=recovery;const recovered=attachWorkspaceEvidence(recovery.input,grounding?.observations || []);generated=await generateAi(recovered.input,signal,fetch,{grounded:recovered.grounded});
    }
    if(grounding){generated.promptTokens=grounding.promptTokens===null || generated.promptTokens===null?null:grounding.promptTokens+generated.promptTokens;generated.outputTokens=grounding.outputTokens===null || generated.outputTokens===null?null:grounding.outputTokens+generated.outputTokens;}
    if(context){generated.promptTokens=context.promptTokens===null || generated.promptTokens===null?null:context.promptTokens+generated.promptTokens;generated.outputTokens=context.outputTokens===null || generated.outputTokens===null?null:context.outputTokens+generated.outputTokens;}
    signal.throwIfAborted();
    const output:AiOutput=generated.result;
    const subject=output.operation==='draft'?output.subject:output.operation==='subjects'?output.subjects.join('\n'):input.subject;
    const text=output.operation==='compact'?output.summary:(output.operation==='rewrite'||output.operation==='chat')?output.text:output.operation==='draft'?output.text:'';
    const html=output.operation==='draft'?output.html:'';
    const scan=scanContent(subject,html,text),classification=await classify(subject,html,text);
    const warnings:string[]=[];
    if(scan.score>=30 || classification.combined_score>=30)warnings.push('Review this copy for spam signals before sending.');
    if(classification.flagged_domains.length)throw new Error('Blocked link domain');
    await withTenant(customerId,async trx=>{
      if(signal.aborted || !await aiActorAllowed(trx,row))throw new Error('Access changed');
      const committed=await trx.updateTable('ai_runs').set({status:'completed',input:null,result:output,warnings:sql<unknown>`${JSON.stringify(warnings)}::jsonb`,prompt_tokens:generated.promptTokens,output_tokens:generated.outputTokens,lease_until:null,updated_at:new Date()})
        .where('customer_id','=',customerId).where('id','=',id).where('attempt','=',row.attempt).where('status','=','running').where('deadline','>',new Date()).executeTakeFirst();
      if(row.chat_id && Number(committed.numUpdatedRows))await trx.updateTable('ai_chat_messages').set({status:'completed',result:output,text,error:null}).where('customer_id','=',customerId).where('run_id','=',id).where('role','=','assistant').execute();
    });
  } catch(error) {
    const restarting=shutdown.aborted && row.attempt<2 && row.deadline>new Date();
    if(!restarting)console.warn('[valasys-ai] run failed',{run_id:row.id,kind:error instanceof AiProviderUnavailableError?'provider_unavailable':error instanceof AiContextOverflowError?'context_overflow':error instanceof AiOutputValidationError?error.code:signal.aborted?'cancelled_or_deadline':'execution_error'});
    await withTenant(customerId,trx=>trx.updateTable('ai_runs').set({status:restarting?'queued':new Date()>=row.deadline?'timed_out':'failed',input:restarting?row.input:null,result:null,lease_until:null,error:restarting?null:error instanceof AiProviderUnavailableError?'Valasys AI is temporarily unavailable. Your conversation is saved; please try again.':'Valasys AI could not finish this request. Please try again.',updated_at:new Date()})
      .where('customer_id','=',customerId).where('id','=',id).where('attempt','=',row.attempt).where('status','=','running').execute());
  } finally {clearInterval(timer);}
}

/** Bounded per-tenant maintenance; no BYPASSRLS credentials or content in queue data. */
export async function maintainAiRuns(customerId:string):Promise<string[]> {
  return withTenant(customerId,async trx=>{
    const now=new Date();
    await trx.updateTable('ai_runs').set({status:'timed_out',input:null,result:null,error:'This AI request expired. Please try again.',lease_until:null,updated_at:now})
      .where('customer_id','=',customerId).where('status','in',['queued','running']).where('deadline','<=',now).execute();
    await trx.updateTable('ai_runs').set({status:'queued',lease_until:null,updated_at:now})
      .where('customer_id','=',customerId).where('status','=','running').where('lease_until','<',now).where('deadline','>',now).where('attempt','<',2).execute();
    await trx.updateTable('ai_runs').set({status:'failed',input:null,error:'AI writing was interrupted. Please try again.',lease_until:null,updated_at:now})
      .where('customer_id','=',customerId).where('status','=','running').where('lease_until','<',now).where('attempt','>=',2).execute();
    // Preserve records under any tenant hold; expired content is never returned by the API.
    const held=await trx.selectFrom('legal_holds').select('id').where('customer_id','=',customerId).where('released_at','is',null).executeTakeFirst();
    const locked=await trx.selectFrom('regulatory_retention_locks').select('id').where('customer_id','=',customerId).where('released_at','is',null).where('retain_until','>',now).executeTakeFirst();
    if(!held && !locked){
      await trx.updateTable('ai_runs').set({input:null,result:null,warnings:sql<unknown>`'[]'::jsonb`}).where('customer_id','=',customerId).where('expires_at','<',now).execute();
      // Keep minimal quota/idempotency markers for at least a day even with a shorter content TTL.
      await trx.deleteFrom('ai_chats').where('customer_id','=',customerId).where('expires_at','<',now).execute();
      await trx.deleteFrom('ai_runs').where('customer_id','=',customerId).where('expires_at','<',now).where('created_at','<',new Date(Date.now()-86400000)).execute();
    }
    const rows=await trx.selectFrom('ai_runs').select('id').where('customer_id','=',customerId).where('status','=','queued').where('deadline','>',now).orderBy('created_at').limit(100).execute();
    return rows.map(r=>r.id);
  });
}

export async function aiTenantPage(after:string) {
  return db.selectFrom('customers').select('id').where('id','>',after).orderBy('id').limit(100).execute();
}
