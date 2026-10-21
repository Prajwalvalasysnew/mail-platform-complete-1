/** Email-editing and workspace tools exposed to the DeepSeek Harness agent runtime over MCP.
 * Every call runs here, inside the platform: tenant authority, link policy and sanitization
 * are enforced on each edit, and each call is persisted as a fenced ai_run_steps row.
 */
import {randomUUID} from 'node:crypto';
import type {Selectable} from 'kysely';
import {z} from 'zod';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import type {AiRunsTable} from '../schema.js';
import {EmailDocument,DocumentToolError,policyProblems,type LinkPolicy} from './email-html.js';
import {READ_TOOLS,ReadCall} from './tool-contracts.js';
import {WorkflowDocument,WORKFLOW_STEP_TYPES,type TemplateRef} from './workflow-draft.js';
import {TRIGGERS,GOALS} from '../workflow-builder.js';
import {readWorkspace} from './workspace-tools.js';

type Run=Selectable<AiRunsTable>;
export type AgentMode='editor'|'workflow'|'assist';
export type AgentWorkspace={
 row:Run;mode:AgentMode;doc:EmailDocument;workflow:WorkflowDocument;templates:TemplateRef[];policy:LinkPolicy;signal:AbortSignal;allowed:(trx:TenantExecutor)=>Promise<boolean>;
 changes:string[];reads:number;seen:Map<string,number>;seq:number;section:boolean;
 /** The one artifact (email or workflow) this turn edits; assistant turns pick it with their first edit. */
 artifact:'email'|'workflow'|null;
 /** Ends the agent session when the model keeps calling tools past the budget; the turn then finishes with what was done. */
 stop?:()=>void;stopped?:boolean;
};
export type ToolOutcome={text:string;isError:boolean};
type Tool={name:string;scope:'email'|'workflow'|'workspace';description:string;inputSchema:Record<string,unknown>;mutates:boolean;run:(ws:AgentWorkspace,args:any)=>Promise<string>|string};

const id={type:'string',description:'Element id from the data-ai attribute, e.g. "e12".'};
const html=(what:string)=>({type:'string',description:`${what} Email-safe HTML: tables/divs/text with inline style attributes only. <style>, <script>, forms and event handlers are removed.`});
const quote=(s:string,max=60)=>{const t=s.replace(/\s+/g,' ').trim();return t.length>max?`“${t.slice(0,max-1)}…”`:`“${t}”`;};
function describeHtml(fragment:string){
 const links=[...fragment.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m=>({href:m[1]!,text:m[2]!.replace(/<[^>]+>/g,'')}));
 const heading=fragment.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1]?.replace(/<[^>]+>/g,'');
 if(links.length===1 && fragment.replace(/<[^>]+>/g,'').trim()===links[0]!.text.trim())return `a button ${quote(links[0]!.text)}${links[0]!.href && links[0]!.href!=='#'?` linking to ${links[0]!.href}`:' (link still needed)'}`;
 return heading?`a section ${quote(heading)}`:'new content';
}
function guard(ws:AgentWorkspace,fragment:string){
 const problems=policyProblems(fragment,ws.policy);
 if(problems.length)throw new DocumentToolError(`Edit rejected, nothing was changed: ${problems.join('; ')}.`);
}
const confirmation=(ws:AgentWorkspace,summary:string)=>{ws.changes.push(summary);return `Done: ${summary}. The email is updated.`;};

export const AGENT_TOOLS:Tool[]=[
 {name:'view_email',scope:'email',mutates:false,description:'Show the current email: subject, preheader and HTML with data-ai element ids (or an outline for very large emails). Call this before editing if you are unsure of the current state.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},run:ws=>ws.doc.view()},
 {name:'read_element',scope:'email',mutates:false,description:'Read the exact HTML of one element (and its children) by id.',
  inputSchema:{type:'object',properties:{id},required:['id'],additionalProperties:false},run:(ws,a)=>ws.doc.read(String(a.id))},
 {name:'update_element',scope:'email',mutates:true,description:'Targeted edit of ONE element: replace its text, merge inline CSS styles (any CSS colour value is allowed; an empty string removes a property), and/or set attributes such as href, src, alt, width, align, bgcolor. Everything else in the email stays unchanged. Prefer this for colour, copy and link changes.',
  inputSchema:{type:'object',properties:{id,text:{type:'string',description:'New plain text (only for elements without child blocks).'},styles:{type:'object',additionalProperties:{type:'string'},description:'CSS properties to set, e.g. {"background-color":"#f97316","padding":"32px"}.'},attributes:{type:'object',additionalProperties:{type:'string'},description:'Attributes to set, e.g. {"href":"https://example.com"}.'}},required:['id'],additionalProperties:false},
  run:(ws,a)=>{
   const target=ws.doc.describe(String(a.id));
   if(a.attributes)for(const key of ['href','src','background']){const v=a.attributes[key];if(v)guard(ws,`<a href="${(/^[a-z][a-z0-9+.-]*:|^#|^{{/i.test(v)?v:'https://'+v).replace(/"/g,'&quot;')}"></a>`);}
   if(typeof a.text==='string')guard(ws,a.text);
   const done=ws.doc.update(String(a.id),{text:typeof a.text==='string'?a.text:null,styles:a.styles || null,attributes:a.attributes || null});
   return confirmation(ws,`Updated ${target}: ${done.join(', ')}`);
  }},
 {name:'insert_html',scope:'email',mutates:true,description:'Insert new HTML relative to an element (before, after, inside_start, inside_end) without touching existing content. Use for adding a CTA button, a section, an image row or a footer line. Omit id to insert at the start/end of the whole email.',
  inputSchema:{type:'object',properties:{id:{...id,description:'Reference element id. Omit to insert at the document root.'},position:{type:'string',enum:['before','after','inside_start','inside_end']},html:html('The HTML to insert.')},required:['position','html'],additionalProperties:false},
  run:(ws,a)=>{guard(ws,String(a.html));const where=a.id?`${a.position.replace('_',' ')} ${ws.doc.describe(String(a.id))}`:a.position==='inside_start'?'at the top':'at the end';const ids=ws.doc.insert(a.id?String(a.id):null,String(a.position),String(a.html));return confirmation(ws,`Added ${describeHtml(String(a.html))} ${where}`)+` New element ids: ${ids}.`;}},
 {name:'replace_element',scope:'email',mutates:true,description:'Replace one element (and its children) with new HTML. Use when restructuring a single section; the rest of the email stays unchanged.',
  inputSchema:{type:'object',properties:{id,html:html('Replacement HTML.')},required:['id','html'],additionalProperties:false},
  run:(ws,a)=>{guard(ws,String(a.html));const target=ws.doc.describe(String(a.id));const ids=ws.doc.replace(String(a.id),String(a.html));return confirmation(ws,`Replaced ${target} with ${describeHtml(String(a.html))}`)+` New element ids: ${ids}.`;}},
 {name:'remove_element',scope:'email',mutates:true,description:'Delete one element and its children.',
  inputSchema:{type:'object',properties:{id},required:['id'],additionalProperties:false},
  run:(ws,a)=>{const target=ws.doc.describe(String(a.id));ws.doc.remove(String(a.id));return confirmation(ws,`Removed ${target}`);}},
 {name:'write_email',scope:'email',mutates:true,description:'Write the complete email body from scratch. Use ONLY when the canvas is empty/placeholder or the user explicitly asks for a new email or a complete redesign. For any change to an existing email use the targeted tools instead.',
  inputSchema:{type:'object',properties:{html:html('The complete email body: a centred 600px table layout.'),subject:{type:'string',maxLength:120},preheader:{type:'string',maxLength:200},full_rewrite_reason:{type:'string',description:'Required when the email already has content: quote the user words asking for a new email or redesign.'}},required:['html'],additionalProperties:false},
  run:(ws,a)=>{
   if(ws.section)throw new DocumentToolError('The user is adding a section; use insert_html so the existing email is preserved.');
   if(!ws.doc.isBlank() && !String(a.full_rewrite_reason || '').trim())throw new DocumentToolError('The email already has content. Make targeted edits with update_element/insert_html/replace_element/remove_element. If the user explicitly asked for a brand-new email or full redesign, call write_email again with full_rewrite_reason quoting them.');
   guard(ws,String(a.html));const blank=ws.doc.isBlank();ws.doc.write(String(a.html));
   if(a.subject)ws.doc.subject=String(a.subject).replace(/[\r\n]+/g,' ').slice(0,120);
   if(a.preheader)ws.doc.preheader=String(a.preheader).replace(/[\r\n]+/g,' ').slice(0,200);
   return confirmation(ws,blank?'Created the email design':'Rebuilt the email design')+' Call view_email to see the new element ids.';
  }},
 {name:'set_subject',scope:'email',mutates:true,description:'Set the email subject line and/or preheader (inbox preview text).',
  inputSchema:{type:'object',properties:{subject:{type:'string',maxLength:120},preheader:{type:'string',maxLength:200}},additionalProperties:false},
  run:(ws,a)=>{
   const done:string[]=[];
   for(const key of ['subject','preheader'] as const){if(typeof a[key]==='string' && a[key].trim()){guard(ws,a[key]);ws.doc[key]=a[key].replace(/[\r\n]+/g,' ').trim().slice(0,key==='subject'?120:200);done.push(`${key} ${quote(ws.doc[key])}`);}}
   if(!done.length)throw new DocumentToolError('Provide subject and/or preheader.');
   return confirmation(ws,`Set ${done.join(' and ')}`);
  }},
 {name:'read_workspace',scope:'workspace',mutates:false,description:'Read-only access to the user\'s workspace: workspace_overview, list_campaigns/read_campaign (dispatch and tracking aggregates), list_templates/read_template, list_workflows/read_workflow, list_audiences/read_audience, delivery_summary (7 or 30 days), domain_status (exact connected and verified sending-domain counts), search_history/read_history (this user\'s past AI conversations). Use it whenever the user asks about their account. Report only what it returns.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:[...READ_TOOLS]},id:{type:['string','null'],description:'Record id for read_* tools.'},query:{type:'string',description:'Literal name or phrase filter for list_*/search_history.'},days:{type:'integer',enum:[7,30]}},required:['tool'],additionalProperties:false},
  run:async(ws,a)=>{
   if(ws.reads>=8)throw new DocumentToolError('Workspace read limit reached for this turn. Answer with the evidence you have.');
   const call=ReadCall.parse({tool:a.tool,id:a.id ?? null,query:a.query ?? '',days:a.days ?? 7});ws.reads++;
   try{return JSON.stringify(await readWorkspace(ws.row,call,AbortSignal.any([ws.signal,AbortSignal.timeout(4000)]),ws.allowed)).slice(0,8000);}
   catch{ws.signal.throwIfAborted();throw new DocumentToolError('This workspace read is unavailable for your role or timed out.');}
  }},

 ...workflowTools(),
];

function stepSchema(depth:number):Record<string,unknown>{
 return {type:'object',description:'A workflow step. email {t:"email",template:"<template id>",subject?}; wait {t:"wait",mode:"duration",amount:2,unit:"days"} | {mode:"time",time:"09:00",tz:"contact"} | {mode:"event",event:"opened"|"clicked"|"custom",event_name?,max:3} | {mode:"date",field:"context.appointment_at",direction:"before"|"after",amount:1,unit:"days",if_missed:"continue"|"exit"}; branch/filter {t:"branch",preset:"opened"} or {rules:[{field:"contact.tags",op:"contains",value:"vip"}],match:"all"} with branch paths [{steps:[...]},{steps:[...]}] (yes, no); split {t:"split",pct:50,paths:[{steps},{steps}]}; update {t:"update",action:"add_tag"|"remove_tag"|"stage"|"attribute"|"subscribe"|"unsubscribe",value,key?}; notify {t:"notify",to:["team@x.com"],subject,msg}; webhook {t:"webhook",url:"https://...",payload?}.',
  properties:{t:{type:'string',enum:[...WORKFLOW_STEP_TYPES]},template:{type:'string'},subject:{type:'string'},mode:{type:'string',enum:['duration','time','event','date']},amount:{type:'number'},unit:{type:'string',enum:['minutes','hours','days','weeks']},time:{type:'string'},tz:{type:'string'},event:{type:'string',enum:['opened','clicked','custom']},event_name:{type:'string'},max:{type:'number'},field:{type:'string'},direction:{type:'string',enum:['before','after']},if_missed:{type:'string',enum:['continue','exit']},
   preset:{type:'string'},rules:{type:'array',items:{type:'object',properties:{field:{type:'string'},op:{type:'string'},value:{}},required:['field','op']}},match:{type:'string',enum:['all','any']},pct:{type:'number'},action:{type:'string'},value:{},key:{type:'string'},to:{type:'array',items:{type:'string'}},msg:{type:'string'},url:{type:'string'},payload:{type:'object'},
   ...(depth>0?{paths:{type:'array',maxItems:2,items:{type:'object',properties:{label:{type:'string'},steps:{type:'array',items:stepSchema(depth-1)}},required:['steps']}}}:{})},required:['t']};
}
function triggerConfigSchema(){return {type:'object',description:'event_name and filters for event triggers; list_id for "subscribed"; date_field, offset_days, recurrence (yearly|once), hour for date triggers.',properties:{event_name:{type:'string'},filters:{type:'array',items:{type:'object'}},list_id:{type:'string'},date_field:{type:'string'},offset_days:{type:'number'},recurrence:{type:'string',enum:['yearly','once']},hour:{type:'number'}}};}
const issuesNote=(ws:AgentWorkspace)=>{const issues=ws.workflow.issues();return issues.length?` Remaining publish issues: ${issues.join(' ')}`:' The workflow has no publish issues.';};
function workflowTools():Tool[]{return [
 {name:'view_workflow',scope:'workflow',mutates:false,description:'Show the current workflow: trigger, settings, every step with its id and connections, and any publish issues.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},run:ws=>ws.workflow.view()},
 {name:'build_workflow',scope:'workflow',mutates:true,description:'Create the whole workflow from a step list (with nested paths for branch/split). Use ONLY when the workflow is empty or the user explicitly asks for a new workflow or full redesign; otherwise use add_steps/update_step/remove_step.',
  inputSchema:{type:'object',properties:{name:{type:'string'},trigger:{type:'string',enum:TRIGGERS.map(t=>t.key)},trigger_config:triggerConfigSchema(),goal:{type:'string',enum:GOALS.map(g=>g.key)},goal_event:{type:'string'},reentry:{type:'string',enum:['once','every','30d']},steps:{type:'array',items:stepSchema(1)},full_rewrite_reason:{type:'string',description:'Required when the workflow already has steps: quote the user asking for a new workflow or redesign.'}},required:['trigger','steps'],additionalProperties:false},
  run:(ws,a)=>{
   if(!ws.workflow.isBlank() && !String(a.full_rewrite_reason || '').trim())throw new DocumentToolError('The workflow already has steps. Use add_steps/update_step/remove_step for changes. If the user explicitly asked for a new workflow, call build_workflow again with full_rewrite_reason quoting them.');
   const blank=ws.workflow.isBlank();ws.workflow.build(a);
   return confirmation(ws,`${blank?'Built':'Rebuilt'} the workflow “${ws.workflow.doc.name}” with ${ws.workflow.doc.graph.nodes.length-1} steps`)+issuesNote(ws)+' Call view_workflow to see step ids.';
  }},
 {name:'add_steps',scope:'workflow',mutates:true,description:'Insert one or more steps after an existing step (use "trigger" to insert at the start). Whatever followed that step continues after the new steps.',
  inputSchema:{type:'object',properties:{after:{type:'string',description:'Step id (or "trigger").'},port:{type:'string',enum:['out','yes','no','a','b'],description:'Which output of the step: out (default), yes/no for if/else, a/b for A/B split.'},steps:{type:'array',minItems:1,items:stepSchema(1)}},required:['after','steps'],additionalProperties:false},
  run:(ws,a)=>{const before=ws.workflow.doc.graph.nodes.length;ws.workflow.insert(String(a.after),a.port,a.steps);const added=ws.workflow.doc.graph.nodes.slice(before).map(n=>ws.workflow.label(n));return confirmation(ws,`Added ${added.join(', then ')}`)+issuesNote(ws);}},
 {name:'update_step',scope:'workflow',mutates:true,description:'Change fields of one step, e.g. {"amount":3,"unit":"days"} on a wait or {"template":"<id>"} on an email.',
  inputSchema:{type:'object',properties:{id:{type:'string'},fields:{type:'object'}},required:['id','fields'],additionalProperties:false},
  run:(ws,a)=>confirmation(ws,`Changed ${a.id} to ${ws.workflow.update(String(a.id),a.fields || {})}`)+issuesNote(ws)},
 {name:'remove_step',scope:'workflow',mutates:true,description:'Remove one step; its single incoming and outgoing connections are joined.',
  inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},
  run:(ws,a)=>confirmation(ws,`Removed ${ws.workflow.remove(String(a.id))}`)+issuesNote(ws)},
 {name:'set_trigger',scope:'workflow',mutates:true,description:'Set what starts the workflow: an industry business event (order placed, appointment booked, trial started...), a list join, a date (birthday, renewal), email engagement, or API/manual enrollment.',
  inputSchema:{type:'object',properties:{trigger:{type:'string',enum:TRIGGERS.map(t=>t.key)},trigger_config:triggerConfigSchema()},required:['trigger'],additionalProperties:false},
  run:(ws,a)=>confirmation(ws,`Set the trigger to ${ws.workflow.trigger(String(a.trigger),a.trigger_config || {})}`)+issuesNote(ws)},
 {name:'update_workflow_settings',scope:'workflow',mutates:true,description:'Rename the workflow; set the goal (a preset or goal_event for any custom event), re-entry (once/every/30d), who can enter (all/subscribed/rules + entry_rules), quiet hours ({from:"21:00",to:"08:00"} or null) and frequency cap (emails per 7 days, or null).',
  inputSchema:{type:'object',properties:{name:{type:'string'},goal:{type:'string',enum:GOALS.map(g=>g.key)},goal_event:{type:'string'},reentry:{type:'string',enum:['once','every','30d']},entry:{type:'string',enum:['all','subscribed','rules']},entry_rules:{type:'array',items:{type:'object'}},quiet_hours:{type:['object','null'],properties:{from:{type:'string'},to:{type:'string'}}},frequency_cap:{type:['number','null']}},additionalProperties:false},
  run:(ws,a)=>{const done=ws.workflow.settings(a);if(!done.length)throw new DocumentToolError('Provide name, goal or reentry.');return confirmation(ws,`Set ${done.join(', ')}`);}},
];}

/** The tools a turn may see: editors get their own artifact, the assistant gets everything. */
export function toolsFor(ws:Pick<AgentWorkspace,'mode'>){
 return AGENT_TOOLS.filter(t=>t.scope==='workspace' || ws.mode==='assist' || (ws.mode==='editor'?t.scope==='email':t.scope==='workflow'));
}

const bounded=(value:unknown)=>JSON.parse(JSON.stringify(value ?? {},(_k,v)=>typeof v==='string' && v.length>1500?v.slice(0,1500)+'…':v));
async function record(ws:AgentWorkspace,name:string,args:unknown,observation:unknown,status:string){
 await withTenant(ws.row.customer_id,async trx=>{
  const live=await trx.selectFrom('ai_runs').select(['attempt','status','deadline']).where('customer_id','=',ws.row.customer_id).where('id','=',ws.row.id).forUpdate().executeTakeFirst();
  if(ws.signal.aborted || !live || live.attempt!==ws.row.attempt || live.status!=='running' || live.deadline<=new Date() || !await ws.allowed(trx))throw new Error('Stale tool call');
  await trx.insertInto('ai_run_steps').values({id:randomUUID(),customer_id:ws.row.customer_id,run_id:ws.row.id,attempt:ws.row.attempt,seq:++ws.seq,name,status,arguments:bounded(args),observation:bounded(observation)}).execute();
 });
}

/** Execute one model tool call. Tool errors go back to the model so it can correct itself. */
export async function runAgentTool(ws:AgentWorkspace,name:string,args:unknown):Promise<ToolOutcome>{
 ws.signal.throwIfAborted();
 const tool=toolsFor(ws).find(t=>t.name===name);
 if(!tool)return {text:`Unknown tool ${name}.`,isError:true};
 if(tool.mutates && tool.scope!=='workspace'){
  if(ws.artifact && ws.artifact!==tool.scope)return {text:`This turn is already editing the ${ws.artifact}. Make one draft per turn; offer the ${tool.scope} as a next step.`,isError:true};
 }
 const key=name+JSON.stringify(args ?? {}),count=(ws.seen.get(key) || 0)+1;ws.seen.set(key,count);
 if(tool.mutates && count>1 || count>2){await record(ws,name,args,{error:'repeat_call_blocked'},'blocked');return {text:'You already made this exact call and its result is above. Do something different, or reply to the user.',isError:true};}
 if(ws.seq>=40){
  const over=(ws.seen.get('\u0000budget') || 0)+1;ws.seen.set('\u0000budget',over);
  if(over>=3){ws.stopped=true;ws.stop?.();}
  return {text:'Tool budget for this turn is exhausted. Reply to the user now with what you have done.',isError:true};
 }
 try{
  const text=await tool.run(ws,args && typeof args==='object'?args:{});
  if(tool.mutates && tool.scope!=='workspace')ws.artifact=tool.scope;
  // The edit is already applied: a failed audit write must not tell the model it failed (it would redo it).
  try{await record(ws,name,args,tool.mutates?{result:text}:{chars:text.length},'completed');}
  catch(error){if(error instanceof Error && error.message==='Stale tool call')throw error;ws.signal.throwIfAborted();console.warn('[valasys-ai] tool step not recorded',{tool:name});}
  return {text,isError:false};
 }catch(error){
  ws.signal.throwIfAborted();
  if(error instanceof Error && error.message==='Stale tool call')throw error;
  const message=error instanceof DocumentToolError?error.message:error instanceof z.ZodError?`Invalid arguments: ${error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}`:'The tool failed. Try a different approach.';
  await record(ws,name,args,{error:message},'failed');
  return {text:message,isError:true};
 }
}
