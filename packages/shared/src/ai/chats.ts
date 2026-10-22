import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {z} from 'zod';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import {validateTemplate} from '../templates.js';
import {createWorkflow} from '../workflows.js';
import {aiConfig,aiInputByteLimit} from './config.js';
import {AiInput} from './contracts.js';
import {createAiRun,AiRunError} from './runs.js';
import {detachEditorHtml,EDITOR_HTML_LIMIT} from './email-agent.js';
const ContextRef=z.object({kind:z.enum(['campaign','template','workflow','audience']),id:z.string().uuid(),label:z.string().max(100)}).strict();
export const ChatSettings=z.object({
 mem:z.object({ind:z.string().max(40).default(''),about:z.string().max(1500).default(''),voice:z.string().max(1000).default(''),audience:z.string().max(1000).default(''),rules:z.string().max(1500).default(''),learned:z.array(z.tuple([z.string().max(300),z.number().finite()])).max(20).default([])}).strict().optional(),
 skills:z.array(z.object({id:z.string().max(80),name:z.string().trim().min(1).max(100),body:z.string().max(1500),on:z.boolean(),uses:z.number().int().nonnegative().default(0)}).strict()).max(10).default([]),
 editor:z.object({key:z.string().max(100),links:z.array(z.string().url().max(2048).refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password;})).max(20).default([]),content:z.string().max(6000),subject:z.string().max(998),preheader:z.string().max(300).default(''),html:z.string().max(EDITOR_HTML_LIMIT).optional(),tone:z.enum(['Friendly','Professional','Urgent']),section:z.boolean().default(false),design:z.unknown().optional()}).strict().optional(),
 // Workflow builder canvas (tool state) and the page the assistant panel was opened on.
 workflow:z.object({id:z.string().uuid().optional(),document:z.unknown().optional()}).strict().optional(),
 page:z.object({view:z.string().max(40),label:z.string().max(80).optional()}).strict().optional(),
 mode:z.enum(['ask','auto']).default('ask'),context:z.array(ContextRef).max(3).default([]),
 timezone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}).default('UTC'),
}).strict();
export const ChatTurn=z.object({request_id:z.string().uuid(),operation:z.enum(['chat','draft','assist','editor','workflow']),instruction:z.string().trim().min(1).max(4000),settings:ChatSettings.default({})}).strict().refine(v=>Buffer.byteLength(JSON.stringify(withoutCanvas(v.settings)),'utf8')<=(v.settings.editor?10000:3000) && Buffer.byteLength(JSON.stringify(v.settings.workflow?.document ?? null),'utf8')<=200000,'Settings too long');
/** Settings minus canvas state (email HTML, workflow graph), which is never stored with chat history. */
function withoutCanvas(settings:z.infer<typeof ChatSettings>){return {...settings,editor:settings.editor?{...settings.editor,html:undefined}:undefined,workflow:settings.workflow?{...settings.workflow,document:undefined}:undefined};}
const chatExpiry=()=>new Date(Date.now()+aiConfig().chatRetentionDays*86400000);
const missing=()=>new AiRunError('not_found',404,'This conversation is unavailable or has expired.');
export async function ownedChat(trx:TenantExecutor,cid:string,uid:string,id:string){
 return trx.selectFrom('ai_chats').selectAll().where('customer_id','=',cid).where('user_id','=',uid).where('id','=',id).where('expires_at','>',new Date()).executeTakeFirst();
}
export async function createChatTurn(cid:string,uid:string,sid:string,id:string,body:z.infer<typeof ChatTurn>){
 return withTenant(cid,async trx=>{
  await sql`select pg_advisory_xact_lock(hashtextextended(${cid+':'+uid+':ai'},0))`.execute(trx);
  const parsed=AiInput.safeParse({operation:body.operation,instruction:body.instruction,content:JSON.stringify(body.settings),subject:'',tone:body.settings.editor?.tone || 'Professional'});
  if(!parsed.success)throw new AiRunError('ai_context_limit',400,body.settings.workflow?'This workflow is too large for the AI assistant. Remove some steps or ask about one part at a time.':'This request is too large for the AI assistant. Shorten your message or the selected content.');
  const input=parsed.data;
  const stored=withoutCanvas(body.settings);
  if(Buffer.byteLength(JSON.stringify(detachEditorHtml(input).input),'utf8')+1200>aiInputByteLimit(input.operation))throw new AiRunError('ai_context_limit',400,'Shorten your message or workspace instructions to leave room for conversation context.');
  const prior=await trx.selectFrom('ai_runs').select(['chat_id','chat_seq']).where('customer_id','=',cid).where('user_id','=',uid).where('request_id','=',body.request_id).executeTakeFirst();
  let chat=await ownedChat(trx,cid,uid,id);
  if(prior){if(prior.chat_id!==id || !chat)throw missing();return createAiRun(cid,uid,sid,body.request_id,input,{trx,id,seq:prior.chat_seq!});}
  if(!chat){
   const collision=await trx.selectFrom('ai_chats').select('id').where('id','=',id).executeTakeFirst();if(collision)throw missing();
   chat=await trx.insertInto('ai_chats').values({id,customer_id:cid,user_id:uid,title:Array.from(body.instruction).slice(0,80).join(''),settings:stored,expires_at:chatExpiry()}).returningAll().executeTakeFirstOrThrow();
  }
  const seq=chat.next_seq,run=await createAiRun(cid,uid,sid,body.request_id,input,{trx,id,seq});
  await trx.insertInto('ai_chat_messages').values([
   {id:randomUUID(),customer_id:cid,chat_id:id,run_id:run.id,seq,role:'user' as const,text:body.instruction,status:'completed',result:{context_settings:stored},error:null,template_id:null,decision:null},
   {id:randomUUID(),customer_id:cid,chat_id:id,run_id:run.id,seq:seq+1,role:'assistant' as const,text:'',status:'queued',result:null,error:null,template_id:null,decision:null},
  ]).execute();
  await trx.updateTable('ai_chats').set({next_seq:seq+2,settings:stored,updated_at:new Date(),expires_at:chatExpiry()}).where('customer_id','=',cid).where('id','=',id).execute();
  return run;
 });
}
export async function listAiChats(cid:string,uid:string,mainOnly=false){return withTenant(cid,async trx=>{
 let query=trx.selectFrom('ai_chats').select(['id','title','created_at','updated_at','expires_at']).where('customer_id','=',cid).where('user_id','=',uid).where('expires_at','>',new Date());
 // Infer origin from the original turn, since current chat settings are mutable.
 if(mainOnly)query=query.where(sql<boolean>`not coalesce((select (m.result->'context_settings' ? 'workflow' or m.result->'context_settings' ? 'editor') from ai_chat_messages m where m.customer_id=ai_chats.customer_id and m.chat_id=ai_chats.id and m.role='user' order by m.seq asc limit 1),false)`);
 return {chats:await query.orderBy('updated_at','desc').limit(100).execute()};
});}
export async function getAiChat(cid:string,uid:string,id:string,before=2147483647){return withTenant(cid,async trx=>{
 const chat=await ownedChat(trx,cid,uid,id);if(!chat)throw missing();
 const origin=await trx.selectFrom('ai_chat_messages').select('result').where('customer_id','=',cid).where('chat_id','=',id).where('role','=','user').orderBy('seq').executeTakeFirst();
 const originSettings=(origin?.result as any)?.context_settings;
 const surface=originSettings?.workflow?'workflow':originSettings?.editor?'editor':'agent';
 const messages=await trx.selectFrom('ai_chat_messages as m').leftJoin('ai_runs as r','r.id','m.run_id').select(['m.id','m.seq','m.role','m.text','m.result','m.error','m.status','m.run_id','m.template_id','m.workflow_id','m.decision','m.plan_items','m.created_at','r.status as run_status','r.error as run_error','r.created_at as run_created_at','r.updated_at as run_updated_at',sql<boolean>`r.session_id is not null`.as('run_has_session')]).where('m.customer_id','=',cid).where('m.chat_id','=',id).where('m.seq','<',before).orderBy('m.seq','desc').limit(201).execute();
 const steps=await trx.selectFrom('ai_run_steps as s').innerJoin('ai_runs as r','r.id','s.run_id').select(['s.run_id','s.name','s.status','s.created_at']).where('s.customer_id','=',cid).where('r.customer_id','=',cid).where('r.chat_id','=',id).whereRef('s.attempt','=','r.attempt').orderBy('s.created_at','desc').limit(500).execute().then(rows=>rows.reverse());
 return {chat:{...chat,surface},steps,has_more:messages.length>200,before_seq:messages.slice(0,200).at(-1)?.seq,messages:messages.slice(0,200).reverse().map(m=>({...m,status:m.role==='assistant'?(!m.run_has_session && ['queued','running'].includes(m.run_status || m.status)?'failed':m.run_status || m.status):m.status,error:m.run_error || m.error || (!m.run_has_session && m.role==='assistant' && ['queued','running'].includes(m.status)?'The original login session ended. Send a new message to continue.':null)})),checkpoints:await trx.selectFrom('ai_chat_checkpoints').select(['through_seq','created_at']).where('customer_id','=',cid).where('chat_id','=',id).orderBy('through_seq','desc').execute()};
 });}
export async function decideAiDraft(cid:string,uid:string,chatId:string,messageId:string,decision:'applied'|'skipped'){
 return withTenant(cid,async trx=>{
  if(!await ownedChat(trx,cid,uid,chatId))throw missing();
  const message=await trx.selectFrom('ai_chat_messages').selectAll().where('customer_id','=',cid).where('chat_id','=',chatId).where('id','=',messageId).where('role','=','assistant').forUpdate().executeTakeFirst();
  const draft=message?.result as any;
  if(!message || message.status!=='completed' || !['draft','workflow'].includes(draft?.operation))throw missing();
  if(message.decision)return {decision:message.decision,template_id:message.template_id,workflow_id:message.workflow_id};
  if(decision==='skipped'){await trx.updateTable('ai_chat_messages').set({decision}).where('id','=',messageId).where('customer_id','=',cid).execute();return {decision,template_id:null,workflow_id:null};}
  if(draft.operation==='workflow'){
   // Saved as an inactive draft: the user reviews and publishes it in the workflow builder.
   const base=String(draft.name || 'AI workflow').slice(0,180);let name=base;
   for(let n=2;await trx.selectFrom('workflows').select('id').where('customer_id','=',cid).where('name','=',name).executeTakeFirst();n++)name=`${base} (${n})`;
   const created=await createWorkflow({customerId:cid,name,description:'Drafted by Valasys AI',createdByUserId:uid},trx);
   await trx.updateTable('workflows').set({builder_document:{...draft.document,name},builder_revision:sql`builder_revision+1`}).where('customer_id','=',cid).where('id','=',created.id).execute();
   await trx.updateTable('ai_chat_messages').set({decision,workflow_id:created.id}).where('customer_id','=',cid).where('id','=',messageId).execute();
   return {decision,template_id:null,workflow_id:created.id};
  }
  for(const field of [draft.subject,draft.html,draft.text])if(!validateTemplate(field).valid)throw new AiRunError('invalid_template',400,'The generated template cannot be saved.');
  // Lock the immutable proposal and save the template + approval in one transaction.
  const created=await trx.insertInto('templates').values({customer_id:cid,name:draft.subject,subject:draft.subject,html_body:draft.html,text_body:draft.text,editor_document:{schemaVersion:1,preheader:draft.preheader}}).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto('template_versions').values({customer_id:cid,template_id:created.id,revision:created.revision,name:created.name,subject:created.subject,html_body:created.html_body,text_body:created.text_body,editor_document:created.editor_document}).execute();
  await trx.updateTable('ai_chat_messages').set({decision,template_id:created.id}).where('customer_id','=',cid).where('id','=',messageId).execute();
  return {decision,template_id:created.id,workflow_id:null};
 });
}
export async function deleteAiChat(cid:string,uid:string,id:string){return withTenant(cid,async trx=>{
 if(!await ownedChat(trx,cid,uid,id))throw missing();
 const held=await trx.selectFrom('legal_holds').select('id').where('customer_id','=',cid).where('released_at','is',null).executeTakeFirst();
 const locked=await trx.selectFrom('regulatory_retention_locks').select('id').where('customer_id','=',cid).where('released_at','is',null).where('retain_until','>',new Date()).executeTakeFirst();
 if(held || locked)throw new AiRunError('retention_hold',409,'Workspace retention policy prevents deletion.');
 // Stop any reply in flight and erase run content, but keep the run rows: they are the user's quota markers.
 const now=new Date();
 await trx.updateTable('ai_runs').set({status:'cancelled',lease_until:null,updated_at:now}).where('customer_id','=',cid).where('chat_id','=',id).where('status','in',['queued','running']).execute();
 await trx.updateTable('ai_runs').set({input:null,result:null,warnings:sql<unknown>`'[]'::jsonb`,expires_at:now}).where('customer_id','=',cid).where('chat_id','=',id).execute();
 await trx.deleteFrom('ai_run_steps').where('customer_id','=',cid).where('run_id','in',trx.selectFrom('ai_runs').select('id').where('customer_id','=',cid).where('chat_id','=',id)).execute();
 await trx.deleteFrom('ai_chats').where('customer_id','=',cid).where('user_id','=',uid).where('id','=',id).execute();return {deleted:true};
 });}

/** Run inside account deletion's transaction and restore its original tenant context. */
export async function eraseAiUserChats(trx:TenantExecutor,uid:string){
 const original=await sql<{value:string|null}>`select current_setting('app.customer_id',true) as value`.execute(trx);
 const memberships=await trx.selectFrom('memberships').select('customer_id').where('user_id','=',uid).execute();
 try{for(const m of memberships){
  await sql`select set_config('app.customer_id',${m.customer_id},true)`.execute(trx);
  const held=await trx.selectFrom('legal_holds').select('id').where('customer_id','=',m.customer_id).where('released_at','is',null).executeTakeFirst();
  const locked=await trx.selectFrom('regulatory_retention_locks').select('id').where('customer_id','=',m.customer_id).where('released_at','is',null).where('retain_until','>',new Date()).executeTakeFirst();
  if(!held && !locked)await trx.deleteFrom('ai_chats').where('customer_id','=',m.customer_id).where('user_id','=',uid).execute();
 }}finally{await sql`select set_config('app.customer_id',${original.rows[0]?.value || ''},true)`.execute(trx);}
}
