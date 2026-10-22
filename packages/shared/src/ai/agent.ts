/** Harness-inspired typed reads, durable observations, timeouts and repeat-call guard. */
import {randomUUID} from 'node:crypto';
import type {Selectable} from 'kysely';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import type {AiRunsTable} from '../schema.js';
import {AiInput} from './contracts.js';
import {aiInputByteLimit} from './config.js';
import {generateAi,AiProviderUnavailableError} from './provider.js';
import {ReadCall} from './tool-contracts.js';
import {readWorkspace} from './workspace-tools.js';
type Run=Selectable<AiRunsTable>;
// Every conversational turn gets the tool registry, including follow-ups and misspellings.
export const needsWorkspace=(input:AiInput)=>input.instruction!=='/compact';
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
export async function groundAiRequest(row:Run,input:AiInput,signal:AbortSignal,allowed:(trx:TenantExecutor)=>Promise<boolean>){
 const original=JSON.parse(input.content || '{}'),observations:any[]=[],seen=new Set<string>();let seq=0,promptTokens:number|null=0,outputTokens:number|null=0;
 const room=Math.max(0,Math.min(6000,18000-input.content.length-300,aiInputByteLimit(input.operation)-bytes(input)-200));
 async function record(name:string,args:unknown,observation:unknown,status='completed'){
  await withTenant(row.customer_id,async trx=>{
   const live=await trx.selectFrom('ai_runs').select(['attempt','status','deadline']).where('customer_id','=',row.customer_id).where('id','=',row.id).forUpdate().executeTakeFirst();
   if(signal.aborted || !live || live.attempt!==row.attempt || live.status!=='running' || live.deadline<=new Date() || !await allowed(trx))throw new Error('Stale tool observation');
   await trx.insertInto('ai_run_steps').values({id:randomUUID(),customer_id:row.customer_id,run_id:row.id,attempt:row.attempt,seq:++seq,name,status,arguments:args,observation}).execute();
  });
 }
 async function call(raw:unknown){
  const parsed=ReadCall.safeParse(raw);if(!parsed.success)return;
  const item=parsed.data,key=JSON.stringify(item);if(seen.has(key)){await record(item.tool,item,{error:'repeat_call_blocked'},'blocked');return;}
  if(seen.size>=4)return;seen.add(key);let result:any;
  try{result=await readWorkspace(row,item,AbortSignal.any([signal,AbortSignal.timeout(4000)]),allowed);}catch{signal.throwIfAborted();result={tool:item.tool,error:'read_unavailable'};}
  await record(item.tool,item,result,result.error?'failed':'completed');
  // Preserve complete JSON records. Oversized evidence is explicitly unavailable, never cut mid-JSON.
  if(Array.isArray(result.data)){result={...result,data:[...result.data]};while(result.data.length && bytes([...observations,result])>room){result.data.pop();result.truncated=true;}}
  if(result.data?.text && bytes([...observations,result])>room){result={...result,data:{...result.data,truncated:true}};while(result.data.text.length && bytes([...observations,result])>room)result.data.text=result.data.text.slice(0,-100);}
  if(bytes([...observations,result])<=room)observations.push(result);
  else if(bytes([...observations,{tool:item.tool,error:'evidence_budget_exceeded'}])<=room)observations.push({tool:item.tool,error:'evidence_budget_exceeded'});
 }
 if(room<300){await record('context_budget',{}, {error:'insufficient_evidence_budget'},'blocked');return {input,grounded:false,promptTokens,outputTokens,observations};}
 const refs=original.settings?.context || [];
 for(const ref of refs.slice(0,3)){
  const tool=ref.kind==='template'?'read_template':ref.kind==='campaign'?'read_campaign':ref.kind==='workflow'?'read_workflow':'read_audience';
  await call({tool,id:ref.id,query:'',days:7});
 }
 for(let round=0;round<4 && seen.size<4;round++){
  signal.throwIfAborted();const planning=AiInput.parse({...input,operation:'route',content:JSON.stringify({...original,workspace_observations:observations})});
  let planned;
  try{planned=await generateAi(planning,signal);}catch(error){signal.throwIfAborted();if(error instanceof AiProviderUnavailableError)throw error;await record('read_plan',{}, {error:'planning_unavailable'},'failed');break;}
  promptTokens=promptTokens===null || planned.promptTokens===null?null:promptTokens+planned.promptTokens;outputTokens=outputTokens===null || planned.outputTokens===null?null:outputTokens+planned.outputTokens;
  if(planned.result.operation!=='route')break;
  await record('read_plan',{}, {...planned.result,estimated_prompt_tokens:planned.estimatedPromptTokens});
  if(!planned.result.calls.length)break;
  const before=seen.size;
  for(const item of planned.result.calls)await call(item);
  if(seen.size===before)break;
 }
 await record('context_evidence',{}, {observations});
 const content=JSON.stringify({...original,workspace_observations:observations});
 return {input:{...input,content},grounded:observations.some(x=>!x.error),promptTokens,outputTokens,observations};
}


export function attachWorkspaceEvidence(input:AiInput,observations:any[]){
 const kept=[...observations];
 let value={...input,content:JSON.stringify({...JSON.parse(input.content || '{}'),workspace_observations:kept})};
 while(kept.length && (bytes(value)>aiInputByteLimit(input.operation) || value.content.length>18000)){kept.pop();value={...input,content:JSON.stringify({...JSON.parse(input.content || '{}'),workspace_observations:kept})};}
 return {input:value,grounded:kept.some(x=>!x.error)};
}
