/** Scripted OpenAI-compatible chat-completions server for driving the real DeepSeek Harness runtime in tests. */
import {createServer,type Server} from 'node:http';

export type FakeMessage={role:string;content?:any;tool_calls?:{id:string;function:{name:string;arguments:string}}[];tool_call_id?:string};
/** delayMs holds the response (a slow model); status answers with that HTTP error instead (a failing provider). */
export type FakeTurn={content?:string;calls?:{name:string;arguments:unknown}[];delayMs?:number;status?:number;finish?:string};
export type FakeScript=(request:{messages:FakeMessage[];tools:string[];text:(m:FakeMessage)=>string})=>FakeTurn;

const text=(m:FakeMessage)=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((p:any)=>p.text || '').join(''):'';

export async function startFakeAgentLlm(script:FakeScript){
 const requests:{messages:FakeMessage[];tools:string[];body:Record<string,unknown>}[]=[];
 let callId=0;
 const server:Server=createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
   if(req.url?.endsWith('/models')){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
   const tools=(body.tools || []).map((t:any)=>t.function.name as string);
   requests.push({messages:body.messages,tools,body});
   let turn:FakeTurn;
   try{turn=script({messages:body.messages,tools,text});}catch(error){res.writeHead(500).end(String(error));return;}
   if(turn.status){res.writeHead(turn.status,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'fixture provider failure'}}));return;}
   const respond=()=>{if(res.destroyed)return;
   const calls=(turn.calls || []).map(c=>({id:`call_${++callId}`,type:'function',function:{name:tools.find((t:string)=>t.endsWith(`__${c.name}`)) || c.name,arguments:JSON.stringify(c.arguments)}}));
   const finish=turn.finish || (calls.length?'tool_calls':'stop'),usage={prompt_tokens:120,completion_tokens:30,total_tokens:150};
   if(body.stream){
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=calls.length?{role:'assistant',tool_calls:calls.map((c,index)=>({index,...c}))}:{role:'assistant',content:turn.content || ''};
    res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:finish}],usage})}\n\n`);
    res.end('data: [DONE]\n\n');
   }else res.end(JSON.stringify({id:'r',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:turn.content || null,...(calls.length?{tool_calls:calls}:{})},finish_reason:finish}],usage}));
   };
   if(turn.delayMs)setTimeout(respond,turn.delayMs);else respond();
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const address=server.address() as {port:number};
 return {baseUrl:`http://127.0.0.1:${address.port}`,requests,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

/** The document the model was shown most recently (tool result or the turn prompt). */
export function latestDocument(messages:FakeMessage[]){
 for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]!);if(/data-ai="e\d+"/.test(t))return t;}
 return '';
}
/** The newest user instruction of the turn (or the platform's verification follow-up). */
export const lastUserText=(messages:FakeMessage[])=>{
 for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]!);if(messages[i]!.role!=='user')continue;
  // Platform follow-ups (verification, completeness, output-cap recovery) are plain user messages.
  if(/^(Verification:|Reply to the user|Completeness check:|Your last response hit)/.test(t))return t;const at=t.lastIndexOf('User request:\n');if(at>=0)return t.slice(at+14);}
 return '';
};
export const toolResults=(messages:FakeMessage[])=>{const out:string[]=[];for(let i=messages.length-1;i>=0 && messages[i]!.role==='tool';i--)out.unshift(text(messages[i]!));return out;};
