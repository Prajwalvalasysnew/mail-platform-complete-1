/** Tool-calling chat transport for the agent loop.
 * Ollama's native /api/chat tools are the default; AI_PROVIDER=openai speaks the
 * OpenAI-compatible /v1/chat/completions dialect (DeepSeek, vLLM, LiteLLM gateways).
 */
import {setTimeout as delay} from 'node:timers/promises';
import {aiConfig} from './config.js';
import {AiContextOverflowError,AiProviderUnavailableError,AiOutputValidationError} from './provider.js';

export type ToolCall={id:string;name:string;arguments:unknown};
export type AgentMessage=
 |{role:'system'|'user';content:string}
 |{role:'assistant';content:string;thinking?:string;tool_calls?:ToolCall[]}
 |{role:'tool';tool_call_id:string;name:string;content:string};
export type ToolSpec={name:string;description:string;parameters:Record<string,unknown>};
export type AgentReply={content:string;thinking:string;toolCalls:ToolCall[];promptTokens:number|null;outputTokens:number|null};

async function readJson(response:Response,signal:AbortSignal):Promise<any>{
 const reader=response.body?.getReader();if(!reader)throw new AiProviderUnavailableError();
 let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1_000_000)throw new AiOutputValidationError('output_limit');chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>undefined);}
}
const count=(v:unknown)=>typeof v==='number' && Number.isSafeInteger(v) && v>=0?v:null;
const parseArgs=(raw:unknown)=>{if(typeof raw!=='string')return raw ?? {};try{return raw?JSON.parse(raw):{};}catch{return raw;}};

function ollamaBody(messages:AgentMessage[],tools:ToolSpec[],c:ReturnType<typeof aiConfig>,maxTokens:number){
 return {model:c.model,stream:false,think:c.think,...(tools.length?{tools:tools.map(t=>({type:'function',function:t}))}:{}),
  options:{num_ctx:c.contextTokens,num_predict:maxTokens,temperature:0.4},
  messages:messages.map(m=>m.role==='assistant'?{role:'assistant',content:m.content,...(m.thinking?{thinking:m.thinking}:{}),...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(t=>({function:{name:t.name,arguments:t.arguments}}))}:{})}
   :m.role==='tool'?{role:'tool',tool_name:m.name,content:m.content}:m)};
}
function openAiBody(messages:AgentMessage[],tools:ToolSpec[],c:ReturnType<typeof aiConfig>,maxTokens:number){
 return {model:c.model,stream:false,max_tokens:maxTokens,temperature:0.4,...(tools.length?{tools:tools.map(t=>({type:'function',function:t}))}:{response_format:{type:'json_object'}}),
  messages:messages.map(m=>m.role==='assistant'?{role:'assistant',content:m.content || null,...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(t=>({id:t.id,type:'function',function:{name:t.name,arguments:JSON.stringify(t.arguments ?? {})}}))}:{})}
   :m.role==='tool'?{role:'tool',tool_call_id:m.tool_call_id,content:m.content}:m)};
}

/** One model step. Never returns raw upstream errors; one transient retry within the caller deadline. */
export async function chatWithTools(messages:AgentMessage[],tools:ToolSpec[],signal:AbortSignal,fetcher:typeof fetch=fetch,maxTokens?:number):Promise<AgentReply>{
 const c=aiConfig();if(!c.enabled)throw new Error('AI disabled');
 const openai=c.provider==='openai',limit=maxTokens || c.maxOutputTokens;
 const combined=AbortSignal.any([signal,AbortSignal.timeout(c.timeoutMs)]);
 for(let attempt=0;;attempt++){
  let response:Response;
  try{response=await fetcher(openai?`${c.baseUrl}/v1/chat/completions`:`${c.baseUrl}/api/chat`,{method:'POST',redirect:'error',signal:combined,
   headers:{'Content-Type':'application/json',...(c.token?{Authorization:`Bearer ${c.token}`}:{})},
   body:JSON.stringify(openai?openAiBody(messages,tools,c,limit):ollamaBody(messages,tools,c,limit))});}
  catch{combined.throwIfAborted();if(attempt===0){await delay(500,undefined,{signal:combined});continue;}throw new AiProviderUnavailableError();}
  if(!response.ok){
   if([429,500,502,503,504].includes(response.status) && attempt===0){const retry=Number(response.headers.get('Retry-After'));await response.body?.cancel().catch(()=>undefined);await delay(Number.isFinite(retry) && retry>0?Math.min(3000,retry*1000):800,undefined,{signal:combined});continue;}
   if([400,413].includes(response.status)){const error=await readJson(response,combined).catch(()=>null);if(/context.{0,50}(length|window|limit|exceed)|(length|window|exceed).{0,50}context|too many tokens|maximum context/i.test(JSON.stringify(error)))throw new AiContextOverflowError();}
   else await response.body?.cancel().catch(()=>undefined);
   throw new AiProviderUnavailableError();
  }
  const raw=await readJson(response,combined);
  if(openai){
   const choice=raw?.choices?.[0],message=choice?.message;
   if(!message)throw new AiOutputValidationError('incomplete_response');
   if(choice.finish_reason==='length' && !message.tool_calls?.length)throw new AiOutputValidationError('output_limit');
   return {content:typeof message.content==='string'?message.content:'',thinking:'',
    toolCalls:(message.tool_calls || []).map((t:any,i:number)=>({id:String(t.id || `call_${i}`),name:String(t.function?.name || ''),arguments:parseArgs(t.function?.arguments)})),
    promptTokens:count(raw.usage?.prompt_tokens),outputTokens:count(raw.usage?.completion_tokens)};
  }
  if(raw?.done!==true || !raw.message)throw new AiOutputValidationError('incomplete_response');
  const calls=Array.isArray(raw.message.tool_calls)?raw.message.tool_calls:[];
  if(raw.done_reason==='length' && !calls.length)throw new AiOutputValidationError('output_limit');
  return {content:typeof raw.message.content==='string'?raw.message.content:'',thinking:typeof raw.message.thinking==='string'?raw.message.thinking:'',
   toolCalls:calls.map((t:any,i:number)=>({id:String(t.id || `call_${i}`),name:String(t.function?.name || ''),arguments:parseArgs(t.function?.arguments)})),
   promptTokens:count(raw.prompt_eval_count),outputTokens:count(raw.eval_count)};
 }
}
