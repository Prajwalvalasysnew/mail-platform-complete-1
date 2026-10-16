// Explicit mapping: never silently turn an unsupported reference step into an
// executable email or lose a branch. Raw drafts are stored separately.
export function compileWorkflow(document:any,from:string){
 const graph=document.graph,edge=(id:string,port='out')=>{const edges=graph.edges.filter((edge:any)=>edge.from===id && edge.port===port);if(edges.length>1)throw new Error('Use an explicit split for multiple outgoing connections.');return edges[0]?.to || null;};
 if(!['event','opened','clicked','delivered'].includes(document.tkey))throw new Error('Choose Custom API event or a supported email engagement trigger.');
 if(document.settings?.audience && document.settings.audience!=='all')throw new Error('Audience entry filters are not connected. Choose Everyone who triggers it. Sending consent and suppression checks still apply.');
 if(document.settings?.reentry && !['once','every','30d'].includes(document.settings.reentry))throw new Error('Choose a supported re-entry policy.');
 const condition=(key:string)=>{if(key==='activated')return {field:'context.onboarding_complete',op:'eq',value:true};if(key==='score')return {field:'context.score',op:'gte',value:50};throw new Error('Choose a supported context condition. Engagement, commerce and segment conditions are not connected.');};
 if(document.settings?.quiet || document.settings?.cap)throw new Error('Quiet hours and cross-workflow frequency caps are not implemented. Disable these draft options before publishing.');
 if(document.settings?.goal && !['none','click'].includes(document.settings.goal))throw new Error('This business goal is not connected. Select No goal or Clicks any email.');
 const steps=graph.nodes.filter((node:any)=>node.t!=='trigger').map((node:any)=>{
   const base={id:node.id,next:edge(node.id)};
   switch(node.t){
    case 'email':if(!from)throw new Error('Verify a sending domain before testing or publishing email steps.');if(node.subject?.trim() || node.preheader?.trim())throw new Error('Workflow email uses the saved template subject and preview text. Clear the step overrides and edit the template instead.');return {...base,type:'send_email',template_id:node.template,from};
    case 'wait':if(node.mode==='event'){if(!['opened','clicked'].includes(node.event))throw new Error('Choose an open or click event wait.');if(!Number.isFinite(Number(node.max)) || Number(node.max)<=0)throw new Error('Set a positive maximum event wait.');return {id:node.id,type:'wait_for_event',event_types:[node.event],timeout_seconds:Number(node.max)*86400,scope:'run',on_event:base.next,on_timeout:base.next};}if(node.mode!=='duration')throw new Error('Only duration and engagement-event waits are supported.');if(!['minutes','hours','days'].includes(node.unit) || !Number.isFinite(Number(node.amount)) || Number(node.amount)<0)throw new Error('Choose a valid non-negative duration and unit.');return {...base,type:'delay',duration_seconds:Number(node.amount)*({minutes:60,hours:3600,days:86400}[node.unit as 'days'])};
    case 'split':return {id:node.id,type:'split',percent_a:Number(node.pct),branch_a:edge(node.id,'a'),branch_b:edge(node.id,'b')};
    case 'branch':return {id:node.id,type:'condition',match:'all',rules:[condition(node.cond)],on_true:edge(node.id,'yes'),on_false:edge(node.id,'no')};
    case 'filter':return {id:node.id,type:'condition',match:'all',rules:[condition(node.rule)],on_true:base.next,on_false:null};
    case 'webhook':if(node.method && node.method!=='POST')throw new Error('Workflow webhooks use signed POST requests.');return {...base,type:'webhook',url:node.url};
    default:throw new Error(`Step ${node.t} is not connected to the execution engine. Remove it before publishing; the draft is still saved.`);
   }
 });
 if(!steps.length || !edge('trigger'))throw new Error('Connect the trigger to at least one supported step.');
 return {trigger:document.tkey==='event'?{type:'api'}:{type:'event',event_type:document.tkey},entry_step_id:edge('trigger'),steps,settings:{allow_reentry:['every','30d'].includes(document.settings?.reentry),reentry_cooldown_seconds:document.settings?.reentry==='30d'?30*86400:0,exit_on_events:['unsubscribed','complaint']},...(document.settings?.goal==='click'?{goal:{event_type:'clicked',exit_on_goal:true}}:{})};
}
