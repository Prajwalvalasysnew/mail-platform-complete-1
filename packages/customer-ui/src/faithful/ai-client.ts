import {getResource,performAction,store} from './store';
export const aiIdentity=()=>{const s=store.getState().session;return `${s.token}:${s.identity?.current_customer_id}`;};
type Options={chatId?:string;settings?:unknown;runId?:string;onAccepted?:(row:any)=>void};
/** Idempotent submission or durable-run resume. Detaching never cancels server work. */
export function requestAi(input:Record<string,unknown>,onStatus?:(status:string,run?:any)=>void,options:Options={}){
 const owner=aiIdentity(),request_id=crypto.randomUUID();let stopped=false,detached=false,id:string|undefined,cancellation:Promise<any>|undefined;
 const retryable=(e:any)=>['FETCH_ERROR','TIMEOUT_ERROR','PARSING_ERROR'].includes(e?.status) || (typeof e?.status==='number' && e.status>=500);
 async function reconnect<T>(fn:()=>Promise<T>,settleSubmission=false):Promise<T>{
  for(let attempt=0;;attempt++){
   if(detached || (!settleSubmission && stopped) || owner!==aiIdentity())throw new Error('Generation stopped.');
   try{return await fn();}catch(error){if(attempt>=2 || !retryable(error))throw error;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
  }
 }
 const submitted=options.runId?Promise.resolve({id:options.runId}):reconnect(async()=>{const row=await (options.chatId?
  performAction(`/account/ai/chats/${options.chatId}/turns`,{request_id,operation:input.operation,instruction:input.instruction,settings:options.settings || {}}):
  performAction('/account/ai/generations',{request_id,input}));
  if(!row || typeof row.id!=='string')throw {status:'PARSING_ERROR'};return row;
 },true);
 // A failed cancellation must leave polling alive; the server may still be working.
 const cancel=()=>cancellation ||= (async()=>{const row=await submitted;id=row.id;if(owner!==aiIdentity())throw new Error('Generation stopped.');const result=await performAction(`/account/ai/runs/${id}/cancel`,{});if(result?.status==='cancelled')stopped=true;return result;})().catch(error=>{cancellation=undefined;throw error;});
 const promise=(async()=>{
  const row=await submitted;id=row.id;
  if(stopped){await cancel();throw new Error('Generation stopped.');}
  if(detached || owner!==aiIdentity())throw new Error('Generation stopped.');
  options.onAccepted?.(row);
  // Agent turns run several model steps and may wait in the queue first; the server deadline is authoritative.
  const deadline=Date.now()+1200000;
  while(Date.now()<deadline){
   if(stopped || detached || owner!==aiIdentity())throw new Error('Generation stopped.');
   let run:any;
   try{run=await reconnect(async()=>{
    const value=await getResource(`/account/ai/runs/${encodeURIComponent(id!)}`,true);
    if(!value || value.id!==id || !['queued','running','completed','failed','timed_out','cancelled'].includes(value.status))throw {status:'PARSING_ERROR',data:{message:'AI status could not be read. Reconnecting to your saved request.'}};
    return value;
   });}catch(error){
    if((retryable(error) || (error as any)?.status===429) && !detached && !stopped && owner===aiIdentity()){
     onStatus?.('reconnecting',{steps:[{name:'reconnecting',status:'running'}]});
     await new Promise(r=>setTimeout(r,1000));continue;
    }
    throw error;
   }
   if(stopped || detached || owner!==aiIdentity())throw new Error('Generation stopped.');
   onStatus?.(run.status,run);
   if(run.status==='completed')return run;
   if(!['queued','running'].includes(run.status))throw new Error(run.error || (run.status==='cancelled'?'Generation stopped.':'AI could not finish. Please try again.'));
   await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('The request is taking longer than expected. Reopen the conversation to check its saved status.');
 })();
 return {promise,cancel,detach:()=>{detached=true;}};
}
