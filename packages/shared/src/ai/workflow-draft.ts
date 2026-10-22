/** Working workflow-builder document for the AI agent. Uses the builder's own graph
 * ({nodes,edges} with a single "trigger" node) and the shared builder codec, so AI
 * drafts are validated exactly like workflows people build by hand.
 */
import {randomBytes} from 'node:crypto';
import {DocumentToolError,normalizeUrl} from './email-html.js';
import {TRIGGERS,GOALS,RULE_PRESETS,RULE_FIELDS,RULE_OPS,compileWorkflowDetailed,triggerOf,slug,type Rule} from '../workflow-builder.js';

export const WORKFLOW_STEP_TYPES=['email','wait','branch','filter','split','update','notify','webhook'] as const;
type Node={id:string;t:string;x?:number;y?:number;[k:string]:unknown};
type Edge={id:string;from:string;to:string;port:string};
export type WorkflowGraphDoc={name:string;tkey:string;tcfg:Record<string,unknown>;settings:Record<string,unknown>;graph:{nodes:Node[];edges:Edge[]}};
export type StepSpec={t:string;[k:string]:unknown;paths?:{label?:string;steps:StepSpec[]}[]};
export type TemplateRef={id:string;name:string;subject:string|null};
export type WorkflowWorkspace={templates:TemplateRef[];domains:string[];lists:{id:string;name:string}[];timezone:string;
 /** Webhook URLs and alert recipients the user supplied or the workflow already had. Unset: no restriction (tests, codec checks). */
 destinations?:Set<string>};
const emailKey=(value:string)=>`mailto:${value.trim().toLowerCase()}`;

const uid=()=>'n'+randomBytes(4).toString('hex');
const PORTS:Record<string,string[]>={branch:['yes','no'],split:['a','b']};
const DEFAULT_SETTINGS={reentry:'once',goal:'none',entry:'all',quiet:true,qFrom:'21:00',qTo:'08:00',tz:'contact',cap:false,capN:3};
const UNITS=['minutes','hours','days','weeks'];
const str=(v:unknown,max=500)=>typeof v==='string'?v.slice(0,max):v===undefined || v===null?'':String(v).slice(0,max);

function rulesFrom(spec:StepSpec):Rule[]{
 if(Array.isArray(spec.rules))return (spec.rules as any[]).slice(0,10).map(r=>({field:str(r?.field,200),op:str(r?.op,20),...(r?.value!==undefined?{value:Array.isArray(r.value)?r.value.join(', '):r.value}:{})}));
 const key=String(spec.preset ?? spec.cond ?? spec.rule ?? '');
 const preset=RULE_PRESETS.find(p=>p[0]===key);
 if(!preset || key==='custom')throw new DocumentToolError(`${spec.t} needs rules [{field, op, value}] or a preset: ${RULE_PRESETS.filter(p=>p[0]!=='custom').map(p=>p[0]).join(', ')}.`);
 return preset[2].map(r=>key==='tag'?{...r,value:str(spec.tag ?? spec.value)}:{...r});
}

/** Convert an AI step spec into a builder node (defaults filled; detailed checks come from the codec). */
function normalizeStep(spec:StepSpec,ws:WorkflowWorkspace):Node{
 const t=String(spec.t || '');
 if(!(WORKFLOW_STEP_TYPES as readonly string[]).includes(t))throw new DocumentToolError(`Step type "${t}" is not supported. Use one of: ${WORKFLOW_STEP_TYPES.join(', ')} (SMS is not available).`);
 const id=uid();
 switch(t){
  case 'email':{
   const template=str(spec.template,64);
   if(template && !ws.templates.some(x=>x.id===template))throw new DocumentToolError(`Template ${template} does not exist. Use a template id from the list in the request, or leave template empty and tell the user which template to create.`);
   return {id,t,template,subject:str(spec.subject,200),preheader:'',from:str(spec.from,200),fromName:str(spec.from_name ?? spec.fromName,100),replyTo:str(spec.reply_to ?? spec.replyTo,200)};
  }
  case 'wait':{
   const mode=['duration','time','event','date'].includes(String(spec.mode))?String(spec.mode):spec.mode==='before'?'date':'duration';
   const unit=UNITS.includes(String(spec.unit))?String(spec.unit):'days';
   return {id,t,mode,amount:Number(spec.amount ?? 1),unit,time:str(spec.time || '09:00',5),tz:str(spec.tz || spec.timezone || 'contact',64),days:Array.isArray(spec.days)?spec.days:[],
    event:['opened','clicked','custom'].includes(String(spec.event))?String(spec.event):spec.event_name || spec.eventName?'custom':'opened',eventName:slug(str(spec.event_name ?? spec.eventName)),max:Number(spec.max ?? spec.max_days ?? 3),
    field:str(spec.field,200),direction:spec.direction==='after'?'after':'before',ifMissed:spec.if_missed==='exit' || spec.ifMissed==='exit'?'exit':'continue'};
  }
  case 'branch':case 'filter':return {id,t,rules:rulesFrom(spec),match:spec.match==='any'?'any':'all'};
  case 'split':return {id,t,pct:Math.round(Number(spec.pct ?? 50))};
  case 'update':{
   const action=['add_tag','remove_tag','stage','attribute','subscribe','unsubscribe'].includes(String(spec.action))?String(spec.action):'add_tag';
   return {id,t,action,value:Array.isArray(spec.value)?spec.value.join(', '):str(spec.value ?? spec.tags),key:str(spec.key,64)};
  }
  case 'notify':{
   const to=Array.isArray(spec.to)?spec.to.join(', '):str(spec.to);
   // Data leaves the workspace through alerts, so recipients must come from the user, not from workspace content.
   const unknown=to.split(',').map(v=>v.trim()).filter(Boolean).filter(v=>ws.destinations && !ws.destinations.has(emailKey(v)));
   if(unknown.length)throw new DocumentToolError(`${unknown.join(', ')} was not provided by the user. Ask the user which address should receive alerts.`);
   return {id,t,to,subject:str(spec.subject || 'Workflow alert: {{email}}',200),msg:str(spec.msg ?? spec.message ?? spec.body,5000),from:str(spec.from,200)};}
  case 'webhook':{
   const url=str(spec.url,2000),key=url?normalizeUrl(url):null;
   if(url && ws.destinations && (!key || !ws.destinations.has(key)))throw new DocumentToolError(`${url} was not provided by the user. Ask the user for the exact webhook URL.`);
   return {id,t,url,method:'POST',payload:spec.payload && typeof spec.payload==='object'?JSON.stringify(spec.payload):str(spec.payload,4000)};}
 }
 throw new DocumentToolError('Unsupported step.');
}

export class WorkflowDocument{
 doc:WorkflowGraphDoc;
 constructor(input:Partial<WorkflowGraphDoc>|null,private ws:WorkflowWorkspace={templates:[],domains:[],lists:[],timezone:'UTC'}){
  const nodes=Array.isArray(input?.graph?.nodes) && input!.graph!.nodes.some(n=>n.id==='trigger')?structuredClone(input!.graph!.nodes):[{id:'trigger',t:'trigger',x:0,y:0}];
  const edges=Array.isArray(input?.graph?.edges)?structuredClone(input!.graph!.edges):[];
  this.doc={name:String(input?.name || 'Untitled workflow').slice(0,200),tkey:TRIGGERS.some(t=>t.key===input?.tkey)?String(input!.tkey):'event',tcfg:{...(input?.tcfg || {})},settings:{...DEFAULT_SETTINGS,...(input?.settings || {})},graph:{nodes,edges}};
 }
 /** Restrict webhook URLs and alert recipients to the user's links plus those already in this workflow. */
 restrictDestinations(allowed:Set<string>){
  const set=new Set(allowed);
  for(const n of this.doc.graph.nodes){
   if(n.t==='webhook' && typeof n.url==='string'){const key=normalizeUrl(n.url);if(key)set.add(key);}
   if(n.t==='notify' && typeof n.to==='string')for(const v of n.to.split(','))if(v.trim())set.add(emailKey(v));
  }
  this.ws={...this.ws,destinations:set};
 }
 private node(id:string){const n=this.doc.graph.nodes.find(x=>x.id===id);if(!n)throw new DocumentToolError(`Step ${id} does not exist. Call view_workflow for current step ids.`);return n;}
 private out(id:string,port='out'){return this.doc.graph.edges.filter(e=>e.from===id && e.port===port);}
 private ports(n:Node){return n.t==='trigger'?['out']:PORTS[n.t] || ['out'];}
 isBlank(){return this.doc.graph.nodes.length<=1;}
 snapshot(){return JSON.stringify(this.doc);}
 label(n:Node):string{
  if(n.t==='trigger')return `trigger: ${triggerOf(this.doc.tkey).label}`;
  if(n.t==='email'){const t=this.ws.templates.find(x=>x.id===n.template);return `send email ${t?`“${t.name}”`:'(no template selected)'}${n.subject?` subject “${n.subject}”`:''}`;}
  if(n.t==='wait'){
   if(n.mode==='time')return `wait until ${n.time} (${n.tz})`;
   if(n.mode==='event')return `wait up to ${n.max} days for ${n.event==='custom'?`event ${n.eventName}`:n.event}`;
   if(n.mode==='date')return `wait until ${n.amount} ${n.unit} ${n.direction} ${n.field}`;
   return `wait ${n.amount} ${n.unit}`;
  }
  if(n.t==='branch' || n.t==='filter')return `${n.t==='branch'?'if/else':'filter'}: ${((n.rules as Rule[]) || []).map(r=>`${r.field} ${r.op}${r.value!==undefined?` ${r.value}`:''}`).join(n.match==='any'?' OR ':' AND ')}`;
  if(n.t==='split')return `A/B split ${n.pct}% / ${100-Number(n.pct)}%`;
  if(n.t==='update')return `update contact: ${n.action}${n.key?` ${n.key}`:''}${n.value?` “${n.value}”`:''}`;
  if(n.t==='notify')return `notify ${n.to}`;
  if(n.t==='webhook')return `webhook POST ${n.url}`;
  return n.t;
 }
 /** Publish blockers and warnings from the shared builder codec. */
 issueList(){
  const from=this.ws.domains[0]?`hello@${this.ws.domains[0]}`:'';
  return compileWorkflowDetailed(this.doc,{from,domains:this.ws.domains,templates:this.ws.templates.map(t=>t.id),workspaceTz:this.ws.timezone}).issues;
 }
 issues(){return this.issueList().filter(i=>i.level==='error').map(i=>i.id==='trigger'?i.text:`${i.id}: ${i.text}`);}
 view(){
  const d=this.doc,s=d.settings,trig=triggerOf(d.tkey),lines=[`Workflow “${d.name}”`];
  const cfg=d.tcfg as any;
  lines.push(`Trigger: ${d.tkey} (${trig.label}${trig.kind==='custom'?`, event ${cfg.eventName ?? trig.event}`:trig.kind==='audience'?`, list ${this.ws.lists.find(l=>l.id===cfg.list)?.name ?? '(not chosen)'}`:trig.kind==='date'?`, field ${cfg.dateField ?? trig.dateField}, ${cfg.offsetDays ?? trig.offset ?? 0} days`:''})`);
  lines.push(`Settings: entry ${s.entry}, re-entry ${s.reentry}, goal ${s.goal}${s.goal==='custom'?` (${s.goalEvent})`:''}, quiet hours ${s.quiet?`${s.qFrom}-${s.qTo} ${s.tz}`:'off'}, frequency cap ${s.cap?`${s.capN}/7 days`:'off'}`);
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
  const issues=this.issueList();
  lines.push(issues.length?`Issues:\n- ${issues.map(i=>`${i.level==='error'?'BLOCKER':'suggestion'} ${i.id==='trigger'?'':`${i.id}: `}${i.text}`).join('\n- ')}`:'No publish issues.');
  return lines.join('\n');
 }
 private place(steps:StepSpec[],tails:{from:string;port:string}[]):{from:string;port:string}[]{
  for(const spec of steps){
   const n=normalizeStep(spec,this.ws);this.doc.graph.nodes.push(n);
   for(const t of tails)this.doc.graph.edges.push({id:uid(),from:t.from,port:t.port,to:n.id});
   const ports=PORTS[n.t];
   if(ports){
    if(spec.paths && (!Array.isArray(spec.paths) || spec.paths.length>2))throw new DocumentToolError(`${n.t} takes exactly two paths.`);
    tails=ports.flatMap((port,i)=>this.place(spec.paths?.[i]?.steps || [],[{from:n.id,port}]));
   }else tails=[{from:n.id,port:'out'}];
  }
  return tails;
 }
 build(input:{name?:string;trigger:string;trigger_config?:Record<string,unknown>;goal?:string;goal_event?:string;reentry?:string;steps:StepSpec[]}){
  if(!Array.isArray(input.steps) || !input.steps.length || input.steps.length>25)throw new DocumentToolError('Provide 1-25 steps.');
  const backup=this.snapshot();
  try{
   this.doc.graph={nodes:[{id:'trigger',t:'trigger',x:0,y:0}],edges:[]};
   this.trigger(input.trigger,input.trigger_config);
   if(input.name)this.doc.name=String(input.name).slice(0,200);
   this.settings({goal:input.goal,goal_event:input.goal_event,reentry:input.reentry});
   this.place(input.steps,[{from:'trigger',port:'out'}]);
  }catch(error){this.doc=JSON.parse(backup);throw error;}
 }
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
  const next=normalizeStep({...n,...fields,t:n.t,...(fields.rules || fields.preset?{}:{rules:n.rules})} as StepSpec,this.ws);
  Object.assign(n,{...next,id:n.id,x:n.x,y:n.y});
  return this.label(n);
 }
 remove(id:string){
  if(id==='trigger')throw new DocumentToolError('The trigger cannot be removed.');
  const n=this.node(id),label=this.label(n),g=this.doc.graph,ins=g.edges.filter(e=>e.to===id),outs=g.edges.filter(e=>e.from===id);
  g.nodes=g.nodes.filter(x=>x.id!==id);g.edges=g.edges.filter(e=>e.from!==id && e.to!==id);
  if(ins.length===1 && outs.length===1)g.edges.push({id:uid(),from:ins[0]!.from,port:ins[0]!.port,to:outs[0]!.to});
  const reach=new Set(['trigger']);let grew=true;while(grew){grew=false;for(const e of g.edges)if(reach.has(e.from) && !reach.has(e.to)){reach.add(e.to);grew=true;}}
  const dropped=g.nodes.filter(x=>!reach.has(x.id)).length;
  g.nodes=g.nodes.filter(x=>reach.has(x.id));g.edges=g.edges.filter(e=>reach.has(e.from) && reach.has(e.to));
  return dropped?`${label} (and ${dropped} step${dropped>1?'s':''} only reachable through it)`:label;
 }
 trigger(key:string,config:Record<string,unknown>={}){
  const t=TRIGGERS.find(x=>x.key===key);
  if(!t)throw new DocumentToolError(`trigger must be one of: ${TRIGGERS.map(x=>`${x.key} (${x.label})`).join(', ')}.`);
  const cfg:Record<string,unknown>={};
  if(t.kind==='custom' && config.event_name)cfg.eventName=slug(String(config.event_name));
  if(t.kind==='custom' && Array.isArray(config.filters))cfg.filters=rulesFrom({t:'filter',rules:config.filters});
  if(t.kind==='audience'){
   const list=String(config.list_id ?? '');
   if(list && !this.ws.lists.some(l=>l.id===list))throw new DocumentToolError(`List ${list} does not exist. Lists: ${this.ws.lists.map(l=>`${l.id} (${l.name})`).join(', ') || 'none yet'}.`);
   if(list)cfg.list=list;
  }
  if(t.kind==='date'){
   if(config.date_field)cfg.dateField=slug(String(config.date_field));
   if(config.offset_days!==undefined)cfg.offsetDays=Number(config.offset_days);
   if(config.recurrence)cfg.recurrence=config.recurrence==='once'?'once':'yearly';
   if(config.hour!==undefined)cfg.hour=Number(config.hour);
  }
  this.doc.tkey=key;this.doc.tcfg=cfg;
  return t.label;
 }
 /** All-or-nothing: an invalid field leaves the settings unchanged. */
 settings(input:Record<string,unknown>){
  const backup=this.snapshot();
  try{return this.applySettings(input);}catch(error){this.doc=JSON.parse(backup);throw error;}
 }
 private applySettings(input:Record<string,unknown>){
  const done:string[]=[],s=this.doc.settings;
  if(typeof input.name==='string' && input.name.trim()){this.doc.name=input.name.trim().slice(0,200);done.push(`name “${this.doc.name}”`);}
  if(input.goal){if(!GOALS.some(g=>g.key===input.goal))throw new DocumentToolError(`goal must be one of: ${GOALS.map(g=>g.key).join(', ')}.`);s.goal=input.goal;done.push(`goal ${input.goal}`);}
  if(input.goal_event){s.goal='custom';s.goalEvent=slug(String(input.goal_event));done.push(`goal event ${s.goalEvent}`);}
  if(input.reentry){if(!['once','every','30d'].includes(String(input.reentry)))throw new DocumentToolError('reentry must be once, every or 30d.');s.reentry=input.reentry;done.push(`re-entry ${input.reentry}`);}
  if(input.entry){if(!['all','subscribed','rules'].includes(String(input.entry)))throw new DocumentToolError('entry must be all, subscribed or rules.');s.entry=input.entry;done.push(`entry ${input.entry}`);}
  if(Array.isArray(input.entry_rules)){s.entry='rules';s.entryRules=rulesFrom({t:'filter',rules:input.entry_rules});done.push('entry rules');}
  if(input.quiet_hours===null || input.quiet_hours===false){s.quiet=false;done.push('quiet hours off');}
  else if(input.quiet_hours && typeof input.quiet_hours==='object'){const q=input.quiet_hours as any;s.quiet=true;s.qFrom=str(q.from || '21:00',5);s.qTo=str(q.to || '08:00',5);done.push(`quiet hours ${s.qFrom}-${s.qTo}`);}
  if(input.frequency_cap===null || input.frequency_cap===0){s.cap=false;done.push('frequency cap off');}
  else if(input.frequency_cap!==undefined){s.cap=true;s.capN=Math.max(1,Math.min(100,Math.round(Number(input.frequency_cap)) || 3));done.push(`frequency cap ${s.capN} per 7 days`);}
  return done;
 }
}

export const WORKFLOW_GUIDE=`Triggers (set_trigger / build_workflow.trigger): ${TRIGGERS.map(t=>`${t.key}${t.kind==='custom'?`=event ${t.event}`:t.kind==='date'?`=date ${t.dateField}`:''}`).join(', ')}. Custom-event triggers accept trigger_config {event_name, filters}; joins-list ("subscribed") needs {list_id}; date triggers take {date_field, offset_days, recurrence, hour}.
Rule fields: ${RULE_FIELDS.map(f=>f[0].endsWith('.')?`${f[0]}<name>`:f[0]).join(', ')}. Ops: ${RULE_OPS.map(o=>o[0]).join(', ')}. Presets: ${RULE_PRESETS.filter(p=>p[0]!=='custom').map(p=>p[0]).join(', ')}.
Goals: ${GOALS.map(g=>g.key).join(', ')} (or goal_event for any custom event).`;
