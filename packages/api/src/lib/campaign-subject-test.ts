import {randomInt} from 'node:crypto';

// Shuffle before alternating: neither contact creation order nor email domain
// decides a variant. The resulting request is persisted once, never re-drawn.
export function subjectTestPayload(base:Record<string,any>,subjectB:string){
 const recipients=[...base.to] as string[];
 for(let i=recipients.length-1;i>0;i--){const j=randomInt(i+1);[recipients[i],recipients[j]]=[recipients[j]!,recipients[i]!];}
 return {messages:recipients.map((to,index)=>({...base,to,subject:index%2?subjectB:base.subject,metadata:{...base.metadata,campaign_variant:index%2?'B':'A'}}))};
}
export function frozenRecipients(snapshot:any):string[]|null{
 if(Array.isArray(snapshot?.to) && snapshot.to.every((to:unknown)=>typeof to==='string'))return snapshot.to;
 if(Array.isArray(snapshot?.messages) && snapshot.messages.length && snapshot.messages.every((item:any)=>typeof item?.to==='string' && item.metadata?.campaign_launch_id===snapshot.messages[0].metadata?.campaign_launch_id))return snapshot.messages.map((item:any)=>item.to);
 return null;
}
export function frozenLaunchId(snapshot:any):string|undefined{return snapshot?.metadata?.campaign_launch_id || snapshot?.messages?.[0]?.metadata?.campaign_launch_id;}
export function batchCampaignResult(result:any){
 return {...result,message_ids:(result.results || []).filter((item:any)=>item.accepted && typeof item.message_id==='string').map((item:any)=>item.message_id),partial:result.accepted>0 && (result.rejected>0 || result.suppressed>0)};
}
