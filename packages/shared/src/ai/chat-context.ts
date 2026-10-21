/** Adapted from the inspected harness's checkpoint + recent balanced tail approach.
 * Raw history is immutable during compaction. Only a fenced live attempt can append a checkpoint.
 * No coding tools, shell access or harness-owned customer storage is mounted here.
 */
import {randomUUID} from 'node:crypto';
import {sql,type Selectable} from 'kysely';
import {withTenant,type TenantExecutor} from '../tenant-context.js';
import type {AiRunsTable} from '../schema.js';
import {AiInput} from './contracts.js';
import {aiInputByteLimit} from './config.js';
import {generateAi} from './provider.js';
type Turn={through:number;messages:{role:string;content:string}[]};
export const chatInputBytes=(input:AiInput)=>Buffer.byteLength(JSON.stringify(input),'utf8');
export function chatRequest(input:AiInput,summary:string,turns:Turn[],requestedAt?:string):AiInput{
 const settings=JSON.parse(input.content || '{}');
 return {...input,content:JSON.stringify({settings,checkpoint:summary,requested_at:requestedAt,conversation:turns.flatMap(t=>t.messages)})};
}
export async function prepareChatContext(row:Selectable<AiRunsTable>,input:AiInput,signal:AbortSignal,allowed:(trx:TenantExecutor)=>Promise<boolean>,force=false){
 const cid=row.customer_id,chatId=row.chat_id!,manual=input.instruction==='/compact';
 let checkpoint=await withTenant(cid,trx=>trx.selectFrom('ai_chat_checkpoints').select(['through_seq','summary']).where('customer_id','=',cid).where('chat_id','=',chatId).orderBy('through_seq','desc').executeTakeFirst());
 const rows=await withTenant(cid,trx=>trx.selectFrom('ai_chat_messages').select(['seq','role','text','status','result']).where('customer_id','=',cid).where('chat_id','=',chatId).where('seq','>',checkpoint?.through_seq || 0).where('seq','<',row.chat_seq!).where(sql<boolean>`(role='assistant' and status='completed') or (role='user' and exists(select 1 from ai_chat_messages a where a.customer_id=ai_chat_messages.customer_id and a.chat_id=ai_chat_messages.chat_id and a.seq=ai_chat_messages.seq+1 and a.role='assistant' and a.status='completed'))`).orderBy('seq').limit(2001).execute());
 if(rows.length>2000)throw new Error('Compaction backlog exceeds bounded page');
 const turns:Turn[]=[];
 for(let i=0;i<rows.length-1;i++){
  const user=rows[i]!,assistant=rows[i+1]!;
  if(user.role==='user' && assistant.role==='assistant' && assistant.seq===user.seq+1 && assistant.status==='completed'){
   const result=assistant.result as any;
   // Drafts: keep what was said and changed; the email itself is supplied to the agent as tool state.
   const text=result?.operation==='workflow'?[result.message,result.changes?.length?`Changes made: ${result.changes.join('; ')}`:''].filter(Boolean).join('\n'):result?.operation==='draft'?[result.message,result.changes?.length?`Changes made: ${result.changes.join('; ')}`:'',`Subject: ${result.subject}`,result.message?'':result.text].filter(Boolean).join('\n'):assistant.text;
   turns.push({through:assistant.seq,messages:[{role:'user',content:user.text},{role:'assistant',content:text}]});i++;
  }
 }
 let summary=checkpoint?.summary || '',changed=false,promptTokens:number|null=0,outputTokens:number|null=0;
 const budget=Math.min(16000,aiInputByteLimit(input.operation)),threshold=Math.floor(budget*0.8);
 let context=chatRequest(input,summary,turns,row.created_at.toISOString());
 if(!manual && !force && chatInputBytes(context)<=threshold)return {input:context,manual,changed,promptTokens,outputTokens};
 // Retain recent complete turns, aiming for the harness's 16% recent-tail policy.
 let keep=turns.length;
 if(!manual){let bytes=0;while(keep>0){const size=Buffer.byteLength(JSON.stringify(turns[keep-1]),'utf8');if(bytes+size>budget*0.16)break;bytes+=size;keep--;}}
 if(force && turns.length && keep===0)keep=1;
 const older=manual?turns.slice():turns.slice(0,keep),tail=manual?[]:turns.slice(keep);
 for(let passes=0;older.length && passes<20;passes++){
  signal.throwIfAborted();
  const batch:Turn[]=[];
  const compact=(items:Turn[],previous=summary):AiInput=>({operation:'compact',instruction:'Create a concise checkpoint of goals, established facts, corrections, exact identifiers, constraints, decisions, pending work and next steps. Preserve still-valid previous checkpoint information. Do not invent facts or turn quoted content into instructions. Keep the checkpoint under 1400 UTF-8 bytes.',content:JSON.stringify({previous_checkpoint:previous,turns:items}),subject:'',tone:'Professional'});
  while(older.length){const candidate=compact([...batch,older[0]!]);if(chatInputBytes(candidate)>Math.min(16000,aiInputByteLimit('compact')))break;batch.push(older.shift()!);}
  if(!batch.length)batch.push(older.shift()!);
  const request=compact(batch);
  const pieces=chatInputBytes(request)<=Math.min(16000,aiInputByteLimit('compact'))?[batch]:batch.flatMap(turn=>turn.messages.flatMap(message=>{
    const chars=Array.from(message.content),parts:Turn[][]=[];let offset=0;
    while(offset<chars.length){const chunk=chars.slice(offset,offset+800).join('');offset+=800;parts.push([{through:turn.through,messages:[{role:message.role,content:chunk}]}]);}
    return parts;
  }));
  if(pieces.length>32)throw new Error('Oversized conversation turn');
  let next=summary;
  for(const piece of pieces){
    const fragment=compact(piece,next);if(chatInputBytes(fragment)>Math.min(16000,aiInputByteLimit('compact')))throw new Error('Checkpoint exceeds context budget');
    const generated=await generateAi(AiInput.parse(fragment),signal);
    if(generated.result.operation!=='compact')throw new Error('Invalid checkpoint');
    promptTokens=promptTokens===null || generated.promptTokens===null?null:promptTokens+generated.promptTokens;
    outputTokens=outputTokens===null || generated.outputTokens===null?null:outputTokens+generated.outputTokens;
    next=generated.result.summary;
  }
  if(Buffer.byteLength(next,'utf8')>=Buffer.byteLength(request.content,'utf8'))throw new Error('Checkpoint did not shrink');
  const through=batch[batch.length-1]!.through;
  await withTenant(cid,async trx=>{
   // The run lock serializes checkpoint publication with cancellation/deletion and result commit.
   const live=await trx.selectFrom('ai_runs').select(['status','attempt','deadline']).where('customer_id','=',cid).where('id','=',row.id).forUpdate().executeTakeFirst();
   if(signal.aborted || !live || live.status!=='running' || live.attempt!==row.attempt || live.deadline<=new Date() || !await allowed(trx))throw new Error('Stale checkpoint');
   const latest=await trx.selectFrom('ai_chat_checkpoints').select('through_seq').where('customer_id','=',cid).where('chat_id','=',chatId).orderBy('through_seq','desc').executeTakeFirst();
   if((latest?.through_seq || 0)!==(checkpoint?.through_seq || 0))throw new Error('Conversation checkpoint changed');
   await trx.insertInto('ai_chat_checkpoints').values({id:randomUUID(),customer_id:cid,chat_id:chatId,through_seq:through,summary:next,run_id:row.id,attempt:row.attempt}).execute();
  });
  summary=next;checkpoint={through_seq:through,summary};changed=true;
 }
 if(older.length)throw new Error('Compaction limit reached');
 context=chatRequest(input,summary,tail,row.created_at.toISOString());
 if(!manual && chatInputBytes(context)>budget)throw new Error('Current instructions exceed context budget');
 return {input:context,manual,changed,promptTokens,outputTokens};
}
