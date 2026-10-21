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
import {readWorkspace} from './workspace-tools.js';

type Run=Selectable<AiRunsTable>;
export type AgentWorkspace={
 row:Run;doc:EmailDocument;policy:LinkPolicy;signal:AbortSignal;allowed:(trx:TenantExecutor)=>Promise<boolean>;
 changes:string[];reads:number;seen:Map<string,number>;seq:number;section:boolean;
};
export type ToolOutcome={text:string;isError:boolean};
type Tool={name:string;description:string;inputSchema:Record<string,unknown>;mutates:boolean;run:(ws:AgentWorkspace,args:any)=>Promise<string>|string};

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
 {name:'view_email',mutates:false,description:'Show the current email: subject, preheader and HTML with data-ai element ids (or an outline for very large emails). Call this before editing if you are unsure of the current state.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},run:ws=>ws.doc.view()},
 {name:'read_element',mutates:false,description:'Read the exact HTML of one element (and its children) by id.',
  inputSchema:{type:'object',properties:{id},required:['id'],additionalProperties:false},run:(ws,a)=>ws.doc.read(String(a.id))},
 {name:'update_element',mutates:true,description:'Targeted edit of ONE element: replace its text, merge inline CSS styles (any CSS colour value is allowed; an empty string removes a property), and/or set attributes such as href, src, alt, width, align, bgcolor. Everything else in the email stays unchanged. Prefer this for colour, copy and link changes.',
  inputSchema:{type:'object',properties:{id,text:{type:'string',description:'New plain text (only for elements without child blocks).'},styles:{type:'object',additionalProperties:{type:'string'},description:'CSS properties to set, e.g. {"background-color":"#f97316","padding":"32px"}.'},attributes:{type:'object',additionalProperties:{type:'string'},description:'Attributes to set, e.g. {"href":"https://example.com"}.'}},required:['id'],additionalProperties:false},
  run:(ws,a)=>{
   const target=ws.doc.describe(String(a.id));
   if(a.attributes)for(const key of ['href','src','background']){const v=a.attributes[key];if(v)guard(ws,`<a href="${(/^[a-z][a-z0-9+.-]*:|^#|^{{/i.test(v)?v:'https://'+v).replace(/"/g,'&quot;')}"></a>`);}
   if(typeof a.text==='string')guard(ws,a.text);
   const done=ws.doc.update(String(a.id),{text:typeof a.text==='string'?a.text:null,styles:a.styles || null,attributes:a.attributes || null});
   return confirmation(ws,`Updated ${target}: ${done.join(', ')}`);
  }},
 {name:'insert_html',mutates:true,description:'Insert new HTML relative to an element (before, after, inside_start, inside_end) without touching existing content. Use for adding a CTA button, a section, an image row or a footer line. Omit id to insert at the start/end of the whole email.',
  inputSchema:{type:'object',properties:{id:{...id,description:'Reference element id. Omit to insert at the document root.'},position:{type:'string',enum:['before','after','inside_start','inside_end']},html:html('The HTML to insert.')},required:['position','html'],additionalProperties:false},
  run:(ws,a)=>{guard(ws,String(a.html));const where=a.id?`${a.position.replace('_',' ')} ${ws.doc.describe(String(a.id))}`:a.position==='inside_start'?'at the top':'at the end';const ids=ws.doc.insert(a.id?String(a.id):null,String(a.position),String(a.html));return confirmation(ws,`Added ${describeHtml(String(a.html))} ${where}`)+` New element ids: ${ids}.`;}},
 {name:'replace_element',mutates:true,description:'Replace one element (and its children) with new HTML. Use when restructuring a single section; the rest of the email stays unchanged.',
  inputSchema:{type:'object',properties:{id,html:html('Replacement HTML.')},required:['id','html'],additionalProperties:false},
  run:(ws,a)=>{guard(ws,String(a.html));const target=ws.doc.describe(String(a.id));const ids=ws.doc.replace(String(a.id),String(a.html));return confirmation(ws,`Replaced ${target} with ${describeHtml(String(a.html))}`)+` New element ids: ${ids}.`;}},
 {name:'remove_element',mutates:true,description:'Delete one element and its children.',
  inputSchema:{type:'object',properties:{id},required:['id'],additionalProperties:false},
  run:(ws,a)=>{const target=ws.doc.describe(String(a.id));ws.doc.remove(String(a.id));return confirmation(ws,`Removed ${target}`);}},
 {name:'write_email',mutates:true,description:'Write the complete email body from scratch. Use ONLY when the canvas is empty/placeholder or the user explicitly asks for a new email or a complete redesign. For any change to an existing email use the targeted tools instead.',
  inputSchema:{type:'object',properties:{html:html('The complete email body: a centred 600px table layout.'),subject:{type:'string',maxLength:120},preheader:{type:'string',maxLength:200},full_rewrite_reason:{type:'string',description:'Required when the email already has content: quote the user words asking for a new email or redesign.'}},required:['html'],additionalProperties:false},
  run:(ws,a)=>{
   if(ws.section)throw new DocumentToolError('The user is adding a section; use insert_html so the existing email is preserved.');
   if(!ws.doc.isBlank() && !String(a.full_rewrite_reason || '').trim())throw new DocumentToolError('The email already has content. Make targeted edits with update_element/insert_html/replace_element/remove_element. If the user explicitly asked for a brand-new email or full redesign, call write_email again with full_rewrite_reason quoting them.');
   guard(ws,String(a.html));const blank=ws.doc.isBlank();ws.doc.write(String(a.html));
   if(a.subject)ws.doc.subject=String(a.subject).replace(/[\r\n]+/g,' ').slice(0,120);
   if(a.preheader)ws.doc.preheader=String(a.preheader).replace(/[\r\n]+/g,' ').slice(0,200);
   return confirmation(ws,blank?'Created the email design':'Rebuilt the email design')+' Call view_email to see the new element ids.';
  }},
 {name:'set_subject',mutates:true,description:'Set the email subject line and/or preheader (inbox preview text).',
  inputSchema:{type:'object',properties:{subject:{type:'string',maxLength:120},preheader:{type:'string',maxLength:200}},additionalProperties:false},
  run:(ws,a)=>{
   const done:string[]=[];
   for(const key of ['subject','preheader'] as const){if(typeof a[key]==='string' && a[key].trim()){guard(ws,a[key]);ws.doc[key]=a[key].replace(/[\r\n]+/g,' ').trim().slice(0,key==='subject'?120:200);done.push(`${key} ${quote(ws.doc[key])}`);}}
   if(!done.length)throw new DocumentToolError('Provide subject and/or preheader.');
   return confirmation(ws,`Set ${done.join(' and ')}`);
  }},
 {name:'read_workspace',mutates:false,description:'Read-only access to the user\'s workspace: workspace_overview, list_campaigns/read_campaign (dispatch and tracking aggregates), list_templates/read_template, list_workflows/read_workflow, list_audiences/read_audience, delivery_summary (7 or 30 days), domain_status (exact connected and verified sending-domain counts), search_history/read_history (this user\'s past AI conversations). Use it whenever the user asks about their account. Report only what it returns.',
  inputSchema:{type:'object',properties:{tool:{type:'string',enum:[...READ_TOOLS]},id:{type:['string','null'],description:'Record id for read_* tools.'},query:{type:'string',description:'Literal name or phrase filter for list_*/search_history.'},days:{type:'integer',enum:[7,30]}},required:['tool'],additionalProperties:false},
  run:async(ws,a)=>{
   if(ws.reads>=8)throw new DocumentToolError('Workspace read limit reached for this turn. Answer with the evidence you have.');
   const call=ReadCall.parse({tool:a.tool,id:a.id ?? null,query:a.query ?? '',days:a.days ?? 7});ws.reads++;
   try{return JSON.stringify(await readWorkspace(ws.row,call,AbortSignal.any([ws.signal,AbortSignal.timeout(4000)]),ws.allowed)).slice(0,8000);}
   catch{ws.signal.throwIfAborted();throw new DocumentToolError('This workspace read is unavailable for your role or timed out.');}
  }},
];

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
 const tool=AGENT_TOOLS.find(t=>t.name===name);
 if(!tool)return {text:`Unknown tool ${name}.`,isError:true};
 const key=name+JSON.stringify(args ?? {}),count=(ws.seen.get(key) || 0)+1;ws.seen.set(key,count);
 if(tool.mutates && count>1 || count>2){await record(ws,name,args,{error:'repeat_call_blocked'},'blocked');return {text:'You already made this exact call and its result is above. Do something different, or reply to the user.',isError:true};}
 if(ws.seq>=40)return {text:'Tool budget for this turn is exhausted. Reply to the user now with what you have done.',isError:true};
 try{
  const text=await tool.run(ws,args && typeof args==='object'?args:{});
  await record(ws,name,args,tool.mutates?{result:text}:{chars:text.length},'completed');
  return {text,isError:false};
 }catch(error){
  ws.signal.throwIfAborted();
  if(error instanceof Error && error.message==='Stale tool call')throw error;
  const message=error instanceof DocumentToolError?error.message:error instanceof z.ZodError?`Invalid arguments: ${error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}`:'The tool failed. Try a different approach.';
  await record(ws,name,args,{error:message},'failed');
  return {text:message,isError:true};
 }
}
