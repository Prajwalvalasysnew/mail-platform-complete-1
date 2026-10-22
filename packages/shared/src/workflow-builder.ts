// Shared by the customer workflow builder (browser) and the AI workflow tools (server):
// keep this module dependency-free.
// Builder document <-> engine definition. Every option the builder offers maps
// to something the execution engine really does; anything that cannot run is
// reported as an issue on the exact step instead of being silently dropped.

export type Rule = {field:string;op:string;value?:unknown};
export type Issue = {id:string;level:'error'|'warn';text:string};

/** Industry triggers. kind: email engagement event, named business event, list join, date, or direct API/manual start. */
export const TRIGGERS:{key:string;label:string;group:string;kind:'email'|'custom'|'audience'|'date'|'api';event?:string;dateField?:string;offset?:number;recurrence?:'yearly'|'once';hint?:string}[]=[
 {key:'subscribed',label:'Contact joins a list',group:'Audience',kind:'audience',hint:'Runs when a contact is added to the chosen list.'},
 {key:'signup',label:'Contact signs up',group:'Audience',kind:'custom',event:'signed_up'},
 {key:'form',label:'Form is submitted',group:'Audience',kind:'custom',event:'form_submitted'},
 {key:'tag',label:'Tag is added',group:'Audience',kind:'custom',event:'tag_added'},
 {key:'inactive',label:'Contact goes inactive',group:'Audience',kind:'custom',event:'contact_inactive',hint:'Send this event from your system or CRM when a contact stops engaging.'},
 {key:'date',label:'Date-based (birthday, renewal)',group:'Audience',kind:'date',dateField:'birthday',recurrence:'yearly'},
 {key:'opened',label:'Email opened',group:'Engagement',kind:'email',event:'opened'},
 {key:'clicked',label:'Email clicked',group:'Engagement',kind:'email',event:'clicked'},
 {key:'delivered',label:'Email delivered',group:'Engagement',kind:'email',event:'delivered'},
 {key:'bounced',label:'Email soft-bounced',group:'Engagement',kind:'email',event:'soft_bounce'},
 {key:'order',label:'Order is placed',group:'Commerce',kind:'custom',event:'order_placed'},
 {key:'shipped',label:'Order is shipped',group:'Commerce',kind:'custom',event:'order_shipped'},
 {key:'cart',label:'Checkout is abandoned',group:'Commerce',kind:'custom',event:'checkout_abandoned'},
 {key:'browse',label:'Product page viewed',group:'Commerce',kind:'custom',event:'product_viewed'},
 {key:'trial',label:'Trial starts',group:'SaaS',kind:'custom',event:'trial_started'},
 {key:'trial_end',label:'Trial is about to end',group:'SaaS',kind:'date',dateField:'trial_ends_at',offset:-3,recurrence:'once'},
 {key:'payfail',label:'Payment fails',group:'SaaS',kind:'custom',event:'payment_failed'},
 {key:'score',label:'Lead score reaches a threshold',group:'B2B',kind:'custom',event:'lead_scored'},
 {key:'webinar',label:'Registers for a webinar',group:'B2B',kind:'custom',event:'webinar_registered'},
 {key:'appt',label:'Appointment is booked',group:'Healthcare',kind:'custom',event:'appointment_booked'},
 {key:'visit',label:'Visit is completed',group:'Healthcare',kind:'custom',event:'visit_completed'},
 {key:'booking',label:'Booking is confirmed',group:'Travel',kind:'custom',event:'booking_confirmed'},
 {key:'stay_out',label:'Guest checks out',group:'Travel',kind:'custom',event:'guest_checked_out'},
 {key:'enroll',label:'Enrolls in a course',group:'Education',kind:'custom',event:'course_enrolled'},
 {key:'app',label:'Application is started',group:'Education',kind:'custom',event:'application_started'},
 {key:'kyc',label:'Account opened, verification incomplete',group:'Finance',kind:'custom',event:'kyc_pending'},
 {key:'renewal',label:'Policy or contract renewal is due',group:'Finance',kind:'date',dateField:'renewal_date',offset:-30,recurrence:'once'},
 {key:'donation',label:'Donation is made',group:'Nonprofit',kind:'custom',event:'donation_made'},
 {key:'listing',label:'Saved search has a new listing',group:'Real estate',kind:'custom',event:'listing_matched'},
 {key:'event',label:'Custom event from your system',group:'Developer',kind:'custom',event:'custom_event'},
 {key:'api',label:'Started via API or manually',group:'Developer',kind:'api',hint:'Enroll contacts with POST /v1/workflows/{id}/trigger or bulk enrollment.'},
];
export const triggerOf=(key:string)=>TRIGGERS.find(t=>t.key===key) || TRIGGERS.find(t=>t.key==='event')!;
/** Event data dates that "wait until" can use for triggers that carry one. */
export const TRIGGER_DATE_FIELDS:Record<string,string>={appt:'appointment_at',booking:'check_in_at',webinar:'webinar_at',stay_out:'checked_out_at',trial:'trial_ends_at',enroll:'course_starts_at',shipped:'delivered_at',renewal:'renewal_date',trial_end:'trial_ends_at'};

export const GOALS:{key:string;label:string;event?:string}[]=[
 {key:'none',label:'No goal'},{key:'click',label:'Clicks any email',event:'clicked'},
 {key:'order',label:'Places an order',event:'custom:order_placed'},{key:'convert',label:'Upgrades to paid',event:'custom:upgraded'},
 {key:'paid',label:'Payment succeeds',event:'custom:payment_succeeded'},{key:'book',label:'Books an appointment',event:'custom:appointment_booked'},
 {key:'reply',label:'Replies or books a meeting',event:'custom:meeting_booked'},{key:'submit',label:'Submits the application',event:'custom:application_submitted'},
 {key:'kyc_done',label:'Completes verification',event:'custom:verification_completed'},{key:'donate',label:'Makes a donation',event:'custom:donation_made'},
 {key:'custom',label:'Custom event…'},
];

/** Fields a rule can test. Paths with a trailing "." take a user-entered key. */
export const RULE_FIELDS:[string,string,string][]=[
 ['contact.tags','Tags','Contact'],['contact.status','Subscription status','Contact'],['contact.company','Company','Contact'],['contact.location','Location','Contact'],
 ['contact.email','Email address','Contact'],['contact.timezone','Time zone','Contact'],['contact.attributes.','Custom contact field…','Contact'],
 ['run.last_opened','Opened the previous email','Engagement'],['run.last_clicked','Clicked the previous email','Engagement'],['run.opened','Opened any email in this workflow','Engagement'],['run.clicked','Clicked any email in this workflow','Engagement'],
 ['context.','Event / API data field…','Event data'],
];
export const RULE_OPS:[string,string][]=[
 ['eq','is'],['neq','is not'],['contains','contains / has'],['not_contains','does not contain'],['starts_with','starts with'],['ends_with','ends with'],
 ['gt','is greater than'],['gte','is at least'],['lt','is less than'],['lte','is at most'],['in','is one of (comma separated)'],['not_in','is none of'],
 ['exists','is set'],['not_exists','is empty'],['is_true','is true / yes'],['is_false','is false / no'],['before','is before (date or now-7d)'],['after','is after (date or now-7d)'],
];
export const NO_VALUE_OPS=['exists','not_exists','is_true','is_false'];
/** One-click checks for If/else and Filter; each expands into editable rules. */
export const RULE_PRESETS:[string,string,Rule[]][]=[
 ['opened','Opened the previous email',[{field:'run.last_opened',op:'is_true'}]],
 ['clicked','Clicked the previous email',[{field:'run.last_clicked',op:'is_true'}]],
 ['purchased','Has placed an order',[{field:'contact.attributes.orders_count',op:'gt',value:0}]],
 ['activated','Completed onboarding',[{field:'context.onboarding_complete',op:'is_true'}]],
 ['vip','Has the VIP tag',[{field:'contact.tags',op:'contains',value:'vip'}]],
 ['score','Lead score is 50 or more',[{field:'contact.attributes.lead_score',op:'gte',value:50}]],
 ['subscribed','Is subscribed',[{field:'contact.status',op:'eq',value:'Subscribed'}]],
 ['tag','Has a tag',[{field:'contact.tags',op:'contains',value:''}]],
 ['custom','Custom rules…',[]],
];
/** Old builder documents stored a preset key instead of rules. */
export function rulesOf(node:any):Rule[]{
 if(Array.isArray(node.rules))return node.rules;
 const key=(node.t==='filter'?node.rule ?? node.cond:node.cond ?? node.rule),preset=RULE_PRESETS.find(p=>p[0]===key);
 if(!preset)return [];
 return preset[2].map(r=>key==='tag'?{...r,value:node.tag || ''}:r);
}
const EVENT_NAME=/^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const slug=(s:string)=>s.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64);
const unitSeconds:Record<string,number>={minutes:60,hours:3600,days:86400,weeks:604800};
const clock=(v:unknown)=>typeof v==='string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim());
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const list=(v:unknown)=>String(v ?? '').split(/[,;\s]+/).map(s=>s.trim()).filter(Boolean);
const coerce=(v:unknown)=>{if(typeof v!=='string')return v;const t=v.trim();if(t!=='' && !Number.isNaN(Number(t)) && !/^0\d/.test(t))return Number(t);if(t==='true')return true;if(t==='false')return false;return t;};

export type CompileContext={from:string;domains:string[];templates:string[];workspaceTz:string;lists?:string[]};

/** Compile the builder document. Returns the definition (when error-free) plus every issue found. */
export function compileWorkflowDetailed(document:any,ctx:CompileContext):{definition:any|null;issues:Issue[]}{
 const issues:Issue[]=[],err=(id:string,text:string)=>issues.push({id,level:'error',text}),warn=(id:string,text:string)=>issues.push({id,level:'warn',text});
 const graph=document.graph,nodes:any[]=graph.nodes;
 const edge=(id:string,port='out')=>{const edges=graph.edges.filter((e:any)=>e.from===id && e.port===port);if(edges.length>1)err(id,'This step has two outgoing connections on one port. Use an A/B split or If/else to branch.');return edges[0]?.to || null;};
 const s=document.settings || {},cfg=document.tcfg || {},trig=triggerOf(document.tkey);
 const checkRules=(id:string,rules:Rule[],where:string)=>{
  if(!rules.length)err(id,`${where}: add at least one rule.`);
  return rules.map((r,i)=>{
   const field=String(r.field || '');
   if(!field || field.endsWith('.'))err(id,`${where}: rule ${i+1} needs a field name.`);
   else if(!/^(contact|context|trigger|run|subject)\.[A-Za-z0-9_.-]+$/.test(field))err(id,`${where}: rule ${i+1} has an invalid field.`);
   if(!RULE_OPS.some(o=>o[0]===r.op))err(id,`${where}: rule ${i+1} has an unknown comparison.`);
   const needs=!NO_VALUE_OPS.includes(r.op);
   if(needs && (r.value===undefined || String(r.value).trim()===''))err(id,`${where}: rule ${i+1} needs a value.`);
   const value=['in','not_in'].includes(r.op)?list(r.value):coerce(r.value);
   return needs?{field,op:r.op,value}:{field,op:r.op};
  });
 };

 // Trigger
 let trigger:any;
 if(trig.kind==='email')trigger={type:'event',event_type:trig.event};
 else if(trig.kind==='api')trigger={type:'api'};
 else if(trig.kind==='audience'){if(!cfg.list)err('trigger','Choose the list that starts this workflow.');trigger={type:'audience',collection_id:cfg.list || '00000000-0000-4000-8000-000000000000'};}
 else if(trig.kind==='date'){
  const key=slug(cfg.dateField ?? trig.dateField ?? '');if(!key)err('trigger','Choose the contact date field (for example birthday).');
  const offset=Math.round(Number(cfg.offsetDays ?? trig.offset ?? 0));if(!Number.isFinite(offset) || Math.abs(offset)>365)err('trigger','Days before/after must be between -365 and 365.');
  const hour=Number(cfg.hour ?? 9);
  trigger={type:'date',field:key==='created_at'?'contact.created_at':`contact.attributes.${key}`,offset_days:offset,recurrence:cfg.recurrence ?? trig.recurrence ?? 'yearly',hour:Number.isInteger(hour) && hour>=0 && hour<24?hour:9,timezone:ctx.workspaceTz};
 }else{
  const name=slug(cfg.eventName ?? trig.event ?? '');
  if(!EVENT_NAME.test(name))err('trigger','Enter the event name your system sends (lowercase, e.g. order_placed).');
  trigger={type:'custom_event',event_name:name || 'event'};
  const filters=(cfg.filters || []) as Rule[];
  if(filters.length)trigger.filters=checkRules('trigger',filters,'Trigger filter');
 }

 // Steps
 const steps:any[]=[];
 for(const n of nodes){
  if(n.t==='trigger')continue;
  const base={id:n.id,next:edge(n.id)};
  switch(n.t){
   case 'email':{
    if(!n.template)err(n.id,'Choose an email template.');
    else if(ctx.templates.length && !ctx.templates.includes(n.template))err(n.id,'This template no longer exists. Choose another one.');
    const from=String(n.from || ctx.from || '').trim().toLowerCase();
    if(!from)err(n.id,'Verify a sending domain in Settings before sending email.');
    else if(!emailRe.test(from))err(n.id,'Enter a valid From address.');
    else if(ctx.domains.length && !ctx.domains.includes(from.split('@')[1]!))err(n.id,`Send from a verified domain: ${ctx.domains.join(', ')}.`);
    if(n.replyTo && !emailRe.test(String(n.replyTo).trim()))err(n.id,'Reply-to must be a valid email address.');
    if((n.subject || '').length>70)warn(n.id,'Subject is long and may be cut off on mobile.');
    if(/diagnos|prescription|test result|lab result|pregnan|hiv\b|therapy session/i.test(n.subject || ''))warn(n.id,'Keep health details out of subject lines (privacy).');
    steps.push({...base,type:'send_email',template_id:n.template || '00000000-0000-4000-8000-000000000000',from:from || 'invalid@invalid.invalid',
     ...(n.fromName?{from_name:String(n.fromName).slice(0,100)}:{}),...(n.replyTo?{reply_to:String(n.replyTo).trim()}:{}),...(n.subject?.trim()?{subject:n.subject.trim().slice(0,998)}:{})});
    break;
   }
   case 'wait':{
    const mode=n.mode==='before'?'date':n.mode;
    if(mode==='event'){
     const ev=n.event==='custom'?(EVENT_NAME.test(slug(n.eventName || ''))?`custom:${slug(n.eventName)}`:null):n.event==='clicked'?'clicked':'opened';
     if(!ev)err(n.id,'Enter the event name to wait for.');
     const max=Number(n.max);if(!(max>0) || max>90)err(n.id,'Set a maximum wait between 1 and 90 days so nobody gets stuck.');
     steps.push({id:n.id,type:'wait_for_event',event_types:[ev || 'opened'],timeout_seconds:Math.max(60,Math.round((max>0?max:1)*86400)),scope:n.event==='custom'?'any':'run',on_event:base.next,on_timeout:base.next});
    }else if(mode==='time'){
     if(!clock(n.time))err(n.id,'Enter a time like 09:00.');
     steps.push({...base,type:'wait_until',mode:'time_of_day',time:clock(n.time)?n.time.trim():'09:00',timezone:n.tz && n.tz!=='contact'?n.tz:'contact',...(Array.isArray(n.days) && n.days.length && n.days.length<7?{days:n.days}:{}),if_missed:'continue'});
    }else if(mode==='date'){
     const field=String(n.field || '').trim();
     if(!/^(context|contact\.attributes|trigger)\.[A-Za-z0-9_.-]+$/.test(field))err(n.id,'Choose the date to wait for (an event field or a contact date field).');
     const amount=Number(n.amount ?? 0);if(!(amount>=0) || !unitSeconds[n.unit])err(n.id,'Enter how long before or after the date.');
     const seconds=Math.round((amount || 0)*(unitSeconds[n.unit] || 86400))*(n.direction==='after'?1:-1);
     if(Math.abs(seconds)>365*86400)err(n.id,'Keep the offset within one year.');
     steps.push({...base,type:'wait_until',mode:'field',field:field || 'context.date',offset_seconds:seconds,if_missed:n.ifMissed==='exit'?'exit':'continue'});
    }else{
     const amount=Number(n.amount);if(!(amount>0) || !unitSeconds[n.unit])err(n.id,'Wait must be at least 1 minute.');
     const seconds=Math.round(amount*(unitSeconds[n.unit] || 86400));if(seconds>90*86400)err(n.id,'Waits can be at most 90 days.');
     steps.push({...base,type:'delay',duration_seconds:Math.max(0,Math.min(seconds,90*86400) || 0)});
    }
    break;
   }
   case 'split':{const pct=Math.round(Number(n.pct));if(!(pct>=1 && pct<=99))err(n.id,'Split must send between 1% and 99% down path A.');steps.push({id:n.id,type:'split',percent_a:Math.min(99,Math.max(1,pct || 50)),branch_a:edge(n.id,'a'),branch_b:edge(n.id,'b')});if(!edge(n.id,'a') || !edge(n.id,'b'))warn(n.id,'Connect both paths, or contacts on the empty path simply finish.');break;}
   case 'branch':{const rules=checkRules(n.id,rulesOf(n),'If/else');steps.push({id:n.id,type:'condition',match:n.match==='any'?'any':'all',rules,on_true:edge(n.id,'yes'),on_false:edge(n.id,'no')});break;}
   case 'filter':{const rules=checkRules(n.id,rulesOf(n),'Filter');steps.push({id:n.id,type:'condition',match:n.match==='any'?'any':'all',rules,on_true:base.next,on_false:null});break;}
   case 'update':{
    const value=String(n.value ?? '').trim(),change:any={add_tags:[],remove_tags:[],set_attributes:{}};
    if(n.action==='add_tag' || n.action==='remove_tag'){const tags=list(value).map(t=>t.toLowerCase());if(!tags.length)err(n.id,'Enter the tag.');(n.action==='add_tag'?change.add_tags:change.remove_tags).push(...tags);}
    else if(n.action==='stage'){if(!value)err(n.id,'Enter the lifecycle stage.');change.set_attributes.lifecycle_stage=value;}
    else if(n.action==='attribute'){const key=String(n.key || '').trim();if(!/^[a-zA-Z0-9_]{1,64}$/.test(key))err(n.id,'Field name: letters, digits and _ only.');change.set_attributes[key || 'field']=value===''?null:coerce(value);}
    else if(n.action==='subscribe')change.status='Subscribed';
    else if(n.action==='unsubscribe')change.status='Unsubscribed';
    else err(n.id,'Choose what to change.');
    steps.push({...base,type:'update_contact',...change});
    break;
   }
   case 'notify':{
    const to=list(n.to);if(!to.length)err(n.id,'Enter who should receive the alert.');
    if(to.some(a=>!emailRe.test(a)))err(n.id,'Alert recipients must be email addresses.');if(to.length>5)err(n.id,'Send alerts to at most 5 addresses.');
    if(!String(n.msg || '').trim())err(n.id,'Write the alert message.');
    const from=String(n.from || (ctx.from?`alerts@${ctx.from.split('@')[1]}`:'')).toLowerCase();if(!from)err(n.id,'Verify a sending domain before sending alerts.');
    steps.push({...base,type:'notify',to:to.slice(0,5),from:from || 'invalid@invalid.invalid',subject:String(n.subject || 'Workflow alert: {{email}}').slice(0,200),body:String(n.msg || 'Alert').slice(0,5000)});
    break;
   }
   case 'webhook':{
    let url='';try{const u=new URL(String(n.url || ''));if(u.protocol!=='https:')throw new Error();url=u.toString();}catch{err(n.id,'Webhook URL must start with https://');}
    if(n.method && n.method!=='POST')err(n.id,'Workflow webhooks are signed POST requests.');
    let payload:any;if(String(n.payload || '').trim()){try{payload=JSON.parse(n.payload);if(!payload || typeof payload!=='object' || Array.isArray(payload))throw new Error();}catch{err(n.id,'Extra payload must be a JSON object, e.g. {"source":"workflow"}.');}}
    steps.push({...base,type:'webhook',url:url || 'https://invalid.invalid',...(payload?{payload}:{})});
    break;
   }
   case 'sms':err(n.id,'SMS is not available yet. Remove this step or replace it with an email.');break;
   default:err(n.id,`Step type “${n.t}” is not supported.`);
  }
 }
 const entry=edge('trigger');
 if(!entry)err('trigger','Connect the trigger to the first step.');
 const reachable=new Set<string>(['trigger']);let grew=true;while(grew){grew=false;for(const e of graph.edges)if(reachable.has(e.from) && !reachable.has(e.to)){reachable.add(e.to);grew=true;}}
 for(const n of nodes)if(n.t!=='trigger' && !reachable.has(n.id))warn(n.id,'Not connected, so this step never runs. Connect it or delete it.');
 const sends=nodes.filter(n=>n.t==='email' && reachable.has(n.id)).length;
 if(sends>1 && !nodes.some(n=>n.t==='wait' && reachable.has(n.id)))warn('trigger','Add a wait between emails so contacts are not sent several messages at once.');

 // Settings
 const settings:any={allow_reentry:['every','30d'].includes(s.reentry),reentry_cooldown_seconds:s.reentry==='30d'?30*86400:0,exit_on_events:['unsubscribed','complaint'],default_timezone:ctx.workspaceTz};
 if(s.entry==='subscribed' || s.entry==='rules')settings.entry={match:s.entryMatch==='any'?'any':'all',rules:s.entry==='rules'?checkRules('trigger',s.entryRules || [],'Who can enter'):[],require_subscribed:s.entry==='subscribed' || !!s.entrySubscribed};
 else if(s.audience==='subscribed')settings.entry={match:'all',rules:[],require_subscribed:true};
 if(s.quiet){
  if(!clock(s.qFrom) || !clock(s.qTo))err('trigger','Quiet hours need start and end times like 21:00 and 08:00.');
  else settings.send_window={start:s.qTo,end:s.qFrom,timezone:s.tz==='workspace'?ctx.workspaceTz:'contact'};
 }
 if(s.cap){const n=Math.round(Number(s.capN));if(!(n>=1 && n<=100))err('trigger','Frequency cap must be between 1 and 100 emails.');else settings.frequency_cap={max:n,days:Math.min(30,Math.max(1,Math.round(Number(s.capDays) || 7)))};}
 let goal:any;
 if(s.goal && s.goal!=='none'){
  const g=GOALS.find(x=>x.key===s.goal);
  const ev=s.goal==='custom'?(EVENT_NAME.test(slug(s.goalEvent || ''))?`custom:${slug(s.goalEvent)}`:null):g?.event;
  if(!ev)err('trigger','Enter the goal event name (for example order_placed).');
  else goal={event_type:ev,exit_on_goal:s.goalExit!==false};
 }
 const definition={trigger,entry_step_id:entry,steps,settings,...(goal?{goal}:{})};
 return {definition:issues.some(i=>i.level==='error')?null:definition,issues};
}

/** Throwing variant used before publish and simulation. */
export function compileWorkflow(document:any,ctx:CompileContext|string){
 const c=typeof ctx==='string'?{from:ctx,domains:ctx?[ctx.split('@')[1]!]:[],templates:[],workspaceTz:'UTC'}:ctx;
 const {definition,issues}=compileWorkflowDetailed(document,c);
 if(!definition)throw new Error(issues.find(i=>i.level==='error')!.text);
 return definition;
}
