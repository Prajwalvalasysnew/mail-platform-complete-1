/** Working workflow-builder document for the AI agent. Mirrors the customer builder graph
 * ({nodes,edges} with a single "trigger" node) and validates against what the execution engine
 * can actually publish (same rules as customer-ui/src/faithful/workflow-codec.ts).
 */
import {randomBytes} from 'node:crypto';
import {DocumentToolError} from './email-html.js';

export const WORKFLOW_TRIGGERS:Record<string,string>={event:'Custom API event',opened:'Email opened',clicked:'Email clicked',delivered:'Email delivered'};
export const WORKFLOW_CONDITIONS:Record<string,string>={activated:'Context: onboarding_complete is true',score:'Context: score is at least 50'};
export const WORKFLOW_STEP_TYPES=['email','wait','branch','filter','split','webhook'] as const;
type Node={id:string;t:string;x?:number;y?:number;[k:string]:unknown};
type Edge={id:string;from:string;to:string;port:string};
export type WorkflowGraphDoc={name:string;tkey:string;settings:Record<string,unknown>;graph:{nodes:Node[];edges:Edge[]}};
export type StepSpec={t:string;[k:string]:unknown;paths?:{label?:string;steps:StepSpec[]}[]};
export type TemplateRef={id:string;name:string;subject:string|null};

const uid=()=>'n'+randomBytes(4).toString('hex');
const PORTS:Record<string,string[]>={branch:['yes','no'],split:['a','b']};
const DEFAULT_SETTINGS={reentry:'once',goal:'none',audience:'all',quiet:false,cap:false};

/** Fill defaults the builder expects and keep only fields the engine understands. */
function normalizeStep(spec:StepSpec,templates:TemplateRef[]):Node{
 const t=String(spec.t || '');
 if(!(WORKFLOW_STEP_TYPES as readonly string[]).includes(t))throw new DocumentToolError(`Step type "${t}" is not supported. Use one of: ${WORKFLOW_STEP_TYPES.join(', ')}.`);
 const id=uid();
 switch(t){
  case 'email':{
   const template=String(spec.template || '');
   if(template && !templates.some(x=>x.id===template))throw new DocumentToolError(`Template ${template} does not exist. Use a template id from the list in the request (or leave template empty and tell the user to choose one).`);
   return {id,t,template,subject:'',preheader:''};
  }
  case 'wait':{
   const mode=spec.mode==='event'?'event':'duration';
   if(mode==='event'){const event=spec.event==='clicked'?'clicked':'opened';return {id,t,mode,event,max:Math.max(1,Math.min(90,Number(spec.max) || 3)),amount:1,unit:'days',time:'09:00'};}
   const unit=['minutes','hours','days'].includes(String(spec.unit))?String(spec.unit):'days';
   const amount=Number(spec.amount);if(!Number.isFinite(amount) || amount<0 || amount>365)throw new DocumentToolError('wait.amount must be a number between 0 and 365.');
   return {id,t,mode,amount,unit,time:'09:00',event:'opened',max:3};
  }
  case 'branch':case 'filter':{
   const key=t==='branch'?'cond':'rule',value=String(spec[key] || spec.cond || spec.rule || '');
   if(!WORKFLOW_CONDITIONS[value])throw new DocumentToolError(`${t}.${key} must be one of: ${Object.entries(WORKFLOW_CONDITIONS).map(([k,v])=>`${k} (${v})`).join(', ')}.`);
   return t==='branch'?{id,t,cond:value,tag:''}:{id,t,rule:value};
  }
  case 'split':{const pct=Number(spec.pct ?? 50);if(!Number.isFinite(pct) || pct<1 || pct>99)throw new DocumentToolError('split.pct must be between 1 and 99.');return {id,t,pct:Math.round(pct)};}
  case 'webhook':{
   const url=String(spec.url || '');
   try{const u=new URL(url);if(u.protocol!=='https:' || u.username || u.password)throw new Error();}catch{throw new DocumentToolError('webhook.url must be an https URL the user provided.');}
   return {id,t,url,method:'POST'};
  }
 }
 throw new DocumentToolError('Unsupported step.');
}

export class WorkflowDocument{
 doc:WorkflowGraphDoc;
 constructor(input:Partial<WorkflowGraphDoc>|null,private templates:TemplateRef[]=[]){
  const nodes=Array.isArray(input?.graph?.nodes) && input!.graph!.nodes.some(n=>n.id==='trigger')?structuredClone(input!.graph!.nodes):[{id:'trigger',t:'trigger',x:0,y:0}];
  const edges=Array.isArray(input?.graph?.edges)?structuredClone(input!.graph!.edges):[];
  this.doc={name:String(input?.name || 'Untitled workflow').slice(0,200),tkey:WORKFLOW_TRIGGERS[String(input?.tkey)]?String(input!.tkey):'event',settings:{...DEFAULT_SETTINGS,...(input?.settings || {})},graph:{nodes,edges}};
 }
 private node(id:string){const n=this.doc.graph.nodes.find(x=>x.id===id);if(!n)throw new DocumentToolError(`Step ${id} does not exist. Call view_workflow for current step ids.`);return n;}
 private out(id:string,port='out'){return this.doc.graph.edges.filter(e=>e.from===id && e.port===port);}
 private ports(n:Node){return n.t==='trigger'?['out']:PORTS[n.t] || ['out'];}
 isBlank(){return this.doc.graph.nodes.length<=1;}
 snapshot(){return JSON.stringify(this.doc);}
 label(n:Node){
  if(n.t==='trigger')return `trigger: ${WORKFLOW_TRIGGERS[this.doc.tkey]}`;
  if(n.t==='email'){const t=this.templates.find(x=>x.id===n.template);return `send email ${t?`“${t.name}”`:'(no template selected)'}`;}
  if(n.t==='wait')return n.mode==='event'?`wait up to ${n.max} days for ${n.event}`:`wait ${n.amount} ${n.unit}`;
  if(n.t==='branch')return `if/else on ${WORKFLOW_CONDITIONS[String(n.cond)] || n.cond}`;
  if(n.t==='filter')return `filter: ${WORKFLOW_CONDITIONS[String(n.rule)] || n.rule}`;
  if(n.t==='split')return `A/B split ${n.pct}% / ${100-Number(n.pct)}%`;
  if(n.t==='webhook')return `webhook POST ${n.url}`;
  return n.t;
 }
 view(){
  const d=this.doc,lines=[`Workflow “${d.name}”`,`Trigger: ${d.tkey} (${WORKFLOW_TRIGGERS[d.tkey]}) · goal: ${d.settings.goal} · re-entry: ${d.settings.reentry}`];
  if(this.isBlank())lines.push('The workflow has no steps yet.');
  const seen=new Set<string>();
  const walk=(id:string,depth:number)=>{
   if(seen.has(id) || depth>40)return;seen.add(id);
   const n=this.node(id);
   for(const port of this.ports(n))for(const e of this.out(id,port)){
    const to=this.doc.graph.nodes.find(x=>x.id===e.to);if(!to)continue;
    lines.push(`${'  '.repeat(depth)}${n.id}${port==='out'?'':` [${port}]`} → ${to.id}: ${this.label(to)}`);
    walk(to.id,depth+1);
   }
  };
  walk('trigger',0);
  const issues=this.issues();
  lines.push(issues.length?`Issues blocking publish:\n- ${issues.join('\n- ')}`:'No publish issues.');
  return lines.join('\n');
 }
 /** Publish blockers, matching the client compiler; the agent fixes these before replying. */
 issues(){
  const out:string[]=[],g=this.doc.graph,s=this.doc.settings;
  if(!this.out('trigger').length)out.push('Connect the trigger to at least one step.');
  for(const n of g.nodes){
   if(n.t==='trigger')continue;
   for(const port of this.ports(n))if(this.out(n.id,port).length>1)out.push(`${n.id} has more than one outgoing connection on ${port}; use a split.`);
   if(n.t==='email' && !n.template)out.push(`${n.id}: choose a template for this email step.`);
   if(!g.edges.some(e=>e.to===n.id))out.push(`${n.id} is not connected to the workflow.`);
  }
  if(s.quiet || s.cap)out.push('Quiet hours and frequency caps are not supported; turn them off.');
  if(s.goal && !['none','click'].includes(String(s.goal)))out.push('Goal must be none or click.');
  return out;
 }
 /** Insert steps (with optional branch/split paths) after a node and return the new tail ids. */
 private place(steps:StepSpec[],tails:{from:string;port:string}[]):{from:string;port:string}[]{
  for(const spec of steps){
   const n=normalizeStep(spec,this.templates);this.doc.graph.nodes.push(n);
   for(const t of tails)this.doc.graph.edges.push({id:uid(),from:t.from,port:t.port,to:n.id});
   const ports=PORTS[n.t];
   if(ports){
    if(spec.paths && (!Array.isArray(spec.paths) || spec.paths.length>2))throw new DocumentToolError(`${n.t} takes exactly two paths.`);
    tails=ports.flatMap((port,i)=>this.place(spec.paths?.[i]?.steps || [],[{from:n.id,port}]));
   }else tails=[{from:n.id,port:'out'}];
  }
  return tails;
 }
 build(input:{name?:string;trigger:string;goal?:string;reentry?:string;steps:StepSpec[]}){
  if(!WORKFLOW_TRIGGERS[input.trigger])throw new DocumentToolError(`trigger must be one of: ${Object.entries(WORKFLOW_TRIGGERS).map(([k,v])=>`${k} (${v})`).join(', ')}.`);
  if(!Array.isArray(input.steps) || !input.steps.length || input.steps.length>20)throw new DocumentToolError('Provide 1-20 steps.');
  const backup=this.snapshot();
  try{
   this.doc.graph={nodes:[{id:'trigger',t:'trigger',x:0,y:0}],edges:[]};this.doc.tkey=input.trigger;
   if(input.name)this.doc.name=String(input.name).slice(0,200);
   this.settings({goal:input.goal,reentry:input.reentry});
   this.place(input.steps,[{from:'trigger',port:'out'}]);
  }catch(error){this.doc=JSON.parse(backup);throw error;}
 }
 /** Insert after a step on a port; an existing connection from that port continues after the new steps. */
 insert(after:string,port:string|undefined,steps:StepSpec[]){
  const n=this.node(after),p=port || 'out';
  if(!this.ports(n).includes(p))throw new DocumentToolError(`${after} has ports: ${this.ports(n).join(', ')}.`);
  const backup=this.snapshot();
  try{
   const existing=this.out(after,p);
   this.doc.graph.edges=this.doc.graph.edges.filter(e=>!existing.includes(e));
   const tails=this.place(steps,[{from:after,port:p}]);
   for(const e of existing)for(const t of tails)this.doc.graph.edges.push({id:uid(),from:t.from,port:t.port,to:e.to});
  }catch(error){this.doc=JSON.parse(backup);throw error;}
 }
 update(id:string,fields:Record<string,unknown>){
  const n=this.node(id);if(n.t==='trigger')throw new DocumentToolError('Use set_trigger to change the trigger.');
  const next=normalizeStep({...n,...fields,t:n.t} as StepSpec,this.templates);
  Object.assign(n,{...next,id:n.id,x:n.x,y:n.y});
  return this.label(n);
 }
 remove(id:string){
  if(id==='trigger')throw new DocumentToolError('The trigger cannot be removed.');
  const n=this.node(id),label=this.label(n),g=this.doc.graph,ins=g.edges.filter(e=>e.to===id),outs=g.edges.filter(e=>e.from===id);
  g.nodes=g.nodes.filter(x=>x.id!==id);g.edges=g.edges.filter(e=>e.from!==id && e.to!==id);
  if(ins.length===1 && outs.length===1)g.edges.push({id:uid(),from:ins[0]!.from,port:ins[0]!.port,to:outs[0]!.to});
  // Drop steps that are no longer reachable (e.g. the other path of a removed branch).
  const reach=new Set(['trigger']);let grew=true;while(grew){grew=false;for(const e of g.edges)if(reach.has(e.from) && !reach.has(e.to)){reach.add(e.to);grew=true;}}
  const dropped=g.nodes.filter(x=>!reach.has(x.id)).length;
  g.nodes=g.nodes.filter(x=>reach.has(x.id));g.edges=g.edges.filter(e=>reach.has(e.from) && reach.has(e.to));
  return dropped?`${label} (and ${dropped} step${dropped>1?'s':''} only reachable through it)`:label;
 }
 trigger(key:string){if(!WORKFLOW_TRIGGERS[key])throw new DocumentToolError(`trigger must be one of: ${Object.keys(WORKFLOW_TRIGGERS).join(', ')}.`);this.doc.tkey=key;return WORKFLOW_TRIGGERS[key];}
 settings(input:{name?:unknown;goal?:unknown;reentry?:unknown}){
  const done:string[]=[];
  if(typeof input.name==='string' && input.name.trim()){this.doc.name=input.name.trim().slice(0,200);done.push(`name “${this.doc.name}”`);}
  if(input.goal!==undefined && input.goal!==null && input.goal!==''){if(!['none','click'].includes(String(input.goal)))throw new DocumentToolError('goal must be none or click.');this.doc.settings.goal=input.goal;done.push(`goal ${input.goal}`);}
  if(input.reentry!==undefined && input.reentry!==null && input.reentry!==''){if(!['once','every','30d'].includes(String(input.reentry)))throw new DocumentToolError('reentry must be once, every or 30d.');this.doc.settings.reentry=input.reentry;done.push(`re-entry ${input.reentry}`);}
  return done;
 }
}
