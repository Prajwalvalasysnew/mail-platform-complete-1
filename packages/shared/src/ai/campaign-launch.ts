/** Approval of an AI campaign plan, one part at a time, and its launch.
 * Saving a part creates an ordinary draft record (segment, template, inactive workflow). Launching
 * is a separate decision that needs explicit confirmation: it publishes the workflow and enrolls
 * the audience's sendable contacts, so real email goes out only after the user approves it.
 */
import {sql} from 'kysely';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import {roleHasCapability} from '../memberships.js';
import {validateTemplate} from '../templates.js';
import {createWorkflow,publishWorkflow,updateWorkflow,WorkflowError} from '../workflows.js';
import {triggerWorkflowRunsBulk,kickWorkflowRun,invalidateWorkflowActivityCache} from '../workflow-engine.js';
import {compileWorkflowDetailed} from '../workflow-builder.js';
import {sendableAudienceMembers} from '../audiences.js';
import {recordAuditSafe} from '../audit.js';
import {AiRunError} from './runs.js';
import {ownedChat} from './chats.js';
import {DRAFT_TEMPLATE_PREFIX,type CampaignEmail,type CampaignSegment} from './campaign-plan.js';

/** Largest audience one launch enrolls; bigger audiences need the workflow's own bulk tooling. */
export const CAMPAIGN_LAUNCH_MAX_CONTACTS=Number(process.env.AI_CAMPAIGN_LAUNCH_MAX_CONTACTS ?? 10000);
type Campaign={operation:'campaign';name:string;segment:CampaignSegment|null;emails:CampaignEmail[];workflow:{name:string;document:any;issues:string[]}|null};
type ItemState={decision:'applied'|'skipped';id?:string;at:string;enrolled?:number;not_started?:number};
type Items=Record<string,ItemState>;
type Ctx={trx:TenantExecutor;cid:string;uid:string;chatId:string;messageId:string};

const missing=()=>new AiRunError('not_found',404,'This conversation is unavailable or has expired.');
const PLAN_ITEM=/^(audience|workflow|launch|email:[a-z0-9][a-z0-9_-]{0,31})$/;
export const isPlanItem=(item:string)=>PLAN_ITEM.test(item);

async function load(ctx:Ctx){
 if(!await ownedChat(ctx.trx,ctx.cid,ctx.uid,ctx.chatId))throw missing();
 const message=await ctx.trx.selectFrom('ai_chat_messages').select(['result','status','plan_items']).where('customer_id','=',ctx.cid).where('chat_id','=',ctx.chatId).where('id','=',ctx.messageId).where('role','=','assistant').forUpdate().executeTakeFirst();
 const plan=message?.result as Campaign|undefined;
 if(!message || message.status!=='completed' || plan?.operation!=='campaign')throw missing();
 return {plan,items:(message.plan_items || {}) as Items};
}
async function record(ctx:Ctx,item:string,state:ItemState){
 await ctx.trx.updateTable('ai_chat_messages').set({plan_items:sql`plan_items || ${JSON.stringify({[item]:state})}::jsonb`}).where('customer_id','=',ctx.cid).where('id','=',ctx.messageId).execute();
 return state;
}
async function uniqueName(base:string,taken:(name:string)=>Promise<boolean>){
 const root=base.slice(0,180) || 'Untitled';let name=root;
 for(let n=2;await taken(name);n++)name=`${root} (${n})`;
 return name;
}
const referencedDrafts=(document:any)=>[...new Set<string>((document?.graph?.nodes || []).map((n:any)=>n?.template).filter((t:unknown):t is string=>typeof t==='string' && t.startsWith(DRAFT_TEMPLATE_PREFIX)).map((t:string)=>t.slice(DRAFT_TEMPLATE_PREFIX.length)))];

/** Save one part. Applying is final and idempotent; a skipped part can still be applied later. */
async function apply(ctx:Ctx,item:string,decision:'applied'|'skipped'):Promise<ItemState>{
 const {plan,items}=await load(ctx),done=items[item];
 if(done && (done.decision==='applied' || decision==='skipped'))return done;
 // Plans in different messages lock different rows; serialize name allocation for the tenant.
 if(decision==='applied')await sql`select pg_advisory_xact_lock(hashtextextended(${ctx.cid+':ai-plan-names'},0))`.execute(ctx.trx);
 const at=new Date().toISOString();
 if(decision==='skipped')return record(ctx,item,{decision,at});
 if(item==='audience'){
  const segment=plan.segment;if(!segment)throw new AiRunError('plan_item_missing',404,'This plan has no audience.');
  if(segment.audience_id){
   const found=await ctx.trx.selectFrom('audience_collections').select('id').where('customer_id','=',ctx.cid).where('id','=',segment.audience_id).executeTakeFirst();
   if(!found)throw new AiRunError('audience_not_found',422,`The audience “${segment.name}” was deleted. Ask Valasys AI to choose another audience.`);
   return record(ctx,item,{decision,id:found.id,at});
  }
  const name=await uniqueName(segment.name,async n=>!!await ctx.trx.selectFrom('audience_collections').select('id').where('customer_id','=',ctx.cid).where('name','=',n).executeTakeFirst());
  const row=await ctx.trx.insertInto('audience_collections').values({customer_id:ctx.cid,kind:'segment',name,rules:sql<unknown[]>`${JSON.stringify(segment.rules)}::jsonb`}).returning('id').executeTakeFirstOrThrow();
  recordAuditSafe({customerId:ctx.cid,actorType:'user',actorId:ctx.uid,action:'audience.created',resource:row.id,metadata:{source:'ai_campaign'}});
  return record(ctx,item,{decision,id:row.id,at});
 }
 if(item.startsWith('email:')){
  const email=plan.emails.find(e=>`email:${e.key}`===item);if(!email)throw new AiRunError('plan_item_missing',404,'This plan has no such email.');
  for(const field of [email.subject,email.html,email.text])if(!validateTemplate(field).valid)throw new AiRunError('invalid_template',400,'The generated email cannot be saved.');
  const templateName=await uniqueName(email.name,async n=>!!await ctx.trx.selectFrom('templates').select('id').where('customer_id','=',ctx.cid).where('name','=',n).executeTakeFirst());
  const created=await ctx.trx.insertInto('templates').values({customer_id:ctx.cid,name:templateName,subject:email.subject,html_body:email.html,text_body:email.text,editor_document:{schemaVersion:1,preheader:email.preheader}}).returningAll().executeTakeFirstOrThrow();
  await ctx.trx.insertInto('template_versions').values({customer_id:ctx.cid,template_id:created.id,revision:created.revision,name:created.name,subject:created.subject,html_body:created.html_body,text_body:created.text_body,editor_document:created.editor_document}).execute();
  return record(ctx,item,{decision,id:created.id,at});
 }
 if(item==='workflow'){
  const flow=plan.workflow;if(!flow)throw new AiRunError('plan_item_missing',404,'This plan has no workflow.');
  // Emails the journey sends are saved with it, unless the user skipped them (those steps stay empty).
  const ids:Record<string,string>={};
  for(const key of referencedDrafts(flow.document)){
   if(!plan.emails.some(e=>e.key===key))continue;
   const state=items[`email:${key}`]?.decision==='skipped'?items[`email:${key}`]!:await apply(ctx,`email:${key}`,'applied');
   if(state.decision==='applied' && state.id)ids[key]=state.id;
  }
  const document=structuredClone(flow.document);
  for(const node of document.graph.nodes)if(typeof node.template==='string' && node.template.startsWith(DRAFT_TEMPLATE_PREFIX))node.template=ids[node.template.slice(DRAFT_TEMPLATE_PREFIX.length)] || '';
  const name=await uniqueName(String(flow.name || plan.name || 'AI campaign'),async n=>!!await ctx.trx.selectFrom('workflows').select('id').where('customer_id','=',ctx.cid).where('name','=',n).executeTakeFirst());
  document.name=name;
  const created=await createWorkflow({customerId:ctx.cid,name,description:'Drafted by Valasys AI',createdByUserId:ctx.uid},ctx.trx);
  await ctx.trx.updateTable('workflows').set({builder_document:document,builder_revision:sql`builder_revision+1`}).where('customer_id','=',ctx.cid).where('id','=',created.id).execute();
  return record(ctx,item,{decision,id:created.id,at});
 }
 throw new AiRunError('plan_item_missing',404,'Unknown plan item.');
}

/** Conversation-level launch rules, checked before anything is saved and again under the launch lock. */
async function launchable(ctx:Ctx){
 // One launch per conversation: follow-up versions of a plan must never enroll the audience again.
 const live=await ctx.trx.selectFrom('ai_chat_messages').select('id').where('customer_id','=',ctx.cid).where('chat_id','=',ctx.chatId).where('id','!=',ctx.messageId).where(sql<boolean>`plan_items->'launch'->>'decision'='applied'`).executeTakeFirst();
 if(live)throw new AiRunError('launch_blocked',409,'This conversation already launched a version of this campaign, so nothing was sent again. Manage the live workflow from Automations, or start a new chat for a new campaign.');
 const newer=await ctx.trx.selectFrom('ai_chat_messages as m').innerJoin('ai_chat_messages as cur',join=>join.onRef('cur.chat_id','=','m.chat_id').on('cur.id','=',ctx.messageId)).select('m.id').where('m.customer_id','=',ctx.cid).where('m.chat_id','=',ctx.chatId).where('m.role','=','assistant').where('m.status','=','completed').whereRef('m.seq','>','cur.seq').where(sql<boolean>`m.result->>'operation'='campaign'`).executeTakeFirst();
 if(newer)throw new AiRunError('launch_blocked',409,'A newer version of this campaign plan exists in this conversation. Launch the latest version instead.');
}

async function launch(ctx:Ctx,timezone:string){
 const {plan,items}=await load(ctx);
 if(items.launch?.decision==='applied')return {state:items.launch,runs:[] as string[]};
 await launchable(ctx);
 const member=await ctx.trx.selectFrom('memberships').select('role').where('customer_id','=',ctx.cid).where('user_id','=',ctx.uid).where('scim_active','=',true).executeTakeFirst();
 if(!member || !roleHasCapability(member.role,'send'))throw new AiRunError('forbidden',403,'Your role cannot launch campaigns. Ask a workspace admin to launch it.');
 const audienceId=items.audience?.decision==='applied'?items.audience.id:undefined,workflowId=items.workflow?.decision==='applied'?items.workflow.id:undefined;
 if(!plan.segment || !audienceId)throw new AiRunError('launch_blocked',422,'Approve an audience before launching.');
 if(!plan.workflow || !workflowId)throw new AiRunError('launch_blocked',422,'Approve the workflow before launching.');
 const collection=await ctx.trx.selectFrom('audience_collections').select(['id','kind','rules','name']).where('customer_id','=',ctx.cid).where('id','=',audienceId).executeTakeFirst();
 if(!collection)throw new AiRunError('launch_blocked',422,'The campaign audience was deleted. Ask Valasys AI to choose another audience.');
 const workflow=await ctx.trx.selectFrom('workflows').select(['id','status','builder_document']).where('customer_id','=',ctx.cid).where('id','=',workflowId).forUpdate().executeTakeFirst();
 if(!workflow || workflow.status==='archived')throw new AiRunError('launch_blocked',422,'The campaign workflow was deleted. Ask Valasys AI to rebuild it.');
 if(workflow.status==='active')throw new AiRunError('launch_blocked',409,'This workflow is already live. Manage it from Automations.');
 // Launch what the user saved: any edits they made in the workflow builder since approving count.
 const document=workflow.builder_document as any;
 const domains=(await ctx.trx.selectFrom('sending_domains').select('domain').where('customer_id','=',ctx.cid).where('verified_at','is not',null).execute()).map(d=>d.domain.toLowerCase());
 const templateIds=[...new Set<string>((document?.graph?.nodes || []).map((n:any)=>n?.template).filter((t:unknown):t is string=>typeof t==='string' && /^[0-9a-f-]{36}$/i.test(t)))];
 const templates=templateIds.length?(await ctx.trx.selectFrom('templates').select('id').where('customer_id','=',ctx.cid).where('id','in',templateIds).execute()).map(t=>t.id):[];
 const {definition,issues}=compileWorkflowDetailed(document,{from:domains[0]?`hello@${domains[0]}`:'',domains,templates,workspaceTz:timezone});
 const blockers=issues.filter(i=>i.level==='error').map(i=>i.text);
 // Launch enrolls the confirmed audience once. Any other trigger would keep enrolling future contacts.
 if(definition && definition.trigger?.type!=='api')blockers.push('Set the workflow trigger to “Started via API or manually”: a launch enrolls this audience once, and other triggers keep adding contacts after launch.');
 if(!definition || blockers.length)throw new AiRunError('launch_blocked',422,`Nothing was sent. Fix ${blockers.length===1?'this':'these'} first: ${[...new Set(blockers)].slice(0,5).join(' ')}`);
 const contacts=await sendableAudienceMembers(ctx.trx,ctx.cid,collection as any).select('c.email').orderBy('c.id').limit(CAMPAIGN_LAUNCH_MAX_CONTACTS+1).execute();
 if(!contacts.length)throw new AiRunError('launch_blocked',422,'Nothing was sent: nobody in this audience is subscribed with confirmed consent.');
 if(contacts.length>CAMPAIGN_LAUNCH_MAX_CONTACTS)throw new AiRunError('launch_blocked',422,`Nothing was sent: this audience has more than ${CAMPAIGN_LAUNCH_MAX_CONTACTS.toLocaleString('en-US')} sendable contacts. Publish the workflow from Automations and enroll the audience in batches.`);
 try{
  await updateWorkflow(ctx.cid,workflowId,{definition},ctx.trx);
  await publishWorkflow({customerId:ctx.cid,id:workflowId,publishedByUserId:ctx.uid,notes:'Launched from Valasys AI'},ctx.trx);
 }catch(error){
  if(error instanceof WorkflowError)throw new AiRunError('launch_blocked',422,`Nothing was sent: ${error.message}.`);
  throw error;
 }
 await ctx.trx.updateTable('workflows').set({builder_revision:sql`builder_revision+1`}).where('customer_id','=',ctx.cid).where('id','=',workflowId).execute();
 const runs:string[]=[];let started=0;
 for(let i=0;i<contacts.length;i+=500){
  const res=await triggerWorkflowRunsBulk({customerId:ctx.cid,workflowId,subjects:contacts.slice(i,i+500).map(c=>({email:c.email})),source:'audience',triggerPayload:{collection_id:audienceId,ai_campaign_message:ctx.messageId}},ctx.trx);
  started+=res.started;for(const r of res.results)if(r.started && r.run_id)runs.push(r.run_id);
 }
 const state=await record(ctx,'launch',{decision:'applied',id:workflowId,at:new Date().toISOString(),enrolled:started,not_started:contacts.length-started});
 return {state,runs};
}

/** Decide one part of a campaign plan. Launching requires `confirm` and saves any parts still pending. */
export async function decideAiPlanItem(cid:string,uid:string,chatId:string,messageId:string,item:string,decision:'applied'|'skipped',options:{confirm?:boolean;timezone?:string}={}){
 if(!isPlanItem(item))throw new AiRunError('invalid_decision',400,'Unknown plan item.');
 const ctx=(trx:TenantExecutor):Ctx=>({trx,cid,uid,chatId,messageId});
 if(item!=='launch' || decision==='skipped'){
  const state=await withTenant(cid,trx=>apply(ctx(trx),item,decision));
  return {item,...state,plan_items:await withTenant(cid,async trx=>(await load(ctx(trx))).items)};
 }
 if(!options.confirm)throw new AiRunError('launch_confirmation_required',400,'Launching sends email to the audience. Confirm the launch to continue.');
 // Save every part the user has not skipped (each commits on its own), then publish and enroll atomically.
 const {plan,items}=await withTenant(cid,async trx=>{const loaded=await load(ctx(trx));if(loaded.items.launch?.decision!=='applied')await launchable(ctx(trx));return loaded;});
 if(items.launch?.decision!=='applied'){
  // The audience and workflow are required to launch, so confirming the launch applies them even if skipped earlier; skipped emails stay skipped.
  const parts=[...(plan.segment?['audience']:[]),...plan.emails.map(e=>`email:${e.key}`),...(plan.workflow?['workflow']:[])].filter(part=>items[part]?.decision!=='applied' && !(part.startsWith('email:') && items[part]?.decision==='skipped'));
  for(const part of parts)await withTenant(cid,trx=>apply(ctx(trx),part,'applied'));
 }
 const {state,runs}=await withTenant(cid,trx=>launch(ctx(trx),options.timezone || 'UTC'));
 if(runs.length){
  // Enqueue failures are recovered by the workflow run sweep.
  for(let i=0;i<runs.length;i+=50)await Promise.all(runs.slice(i,i+50).map(run=>kickWorkflowRun(run,cid)));
  await invalidateWorkflowActivityCache(cid).catch(()=>undefined);
  recordAuditSafe({customerId:cid,actorType:'user',actorId:uid,action:'workflow.ai_campaign_launched',resource:state.id,metadata:{enrolled:state.enrolled,chat_message:messageId}});
 }
 return {item,...state,plan_items:await withTenant(cid,async trx=>(await load(ctx(trx))).items)};
}
