// Production inspector for the reference workflow builder: every step and the
// trigger get options that map 1:1 to the execution engine (see workflow-codec).
// Field objects mirror the generated view's own field vocabulary.
import {TRIGGERS,triggerOf,GOALS,RULE_FIELDS,RULE_OPS,RULE_PRESETS,NO_VALUE_OPS,TRIGGER_DATE_FIELDS,rulesOf,slug,type Rule} from './workflow-codec';

type Controller=Record<string,any>;
export type InspectorData={templates:{id:string;name:string;subject:string}[];domains:string[];lists:{id:string;name:string}[];from:string;workspaceTz:string};

const seg=(on:boolean)=>`flex:1;height:30px;padding:0 10px;border:0;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:${on?600:500};white-space:nowrap;${on?'background:#fff;color:oklch(0.20 0.015 260);box-shadow:0 1px 2px oklch(0.2 0.02 260 / 0.10);':'background:transparent;color:oklch(0.48 0.012 260);'}`;
const track=(on:boolean)=>`position:relative;display:block;width:34px;height:20px;flex-shrink:0;margin-top:1px;border-radius:10px;transition:background .15s;background:${on?'oklch(0.56 0.20 25)':'oklch(0.86 0.005 250)'};`;
const knob=(on:boolean)=>`position:absolute;top:2px;left:${on?16:2}px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px oklch(0.2 0.02 260 / 0.25);transition:left .15s;`;
const UNITS=['minutes','hours','days','weeks'];
const unitTxt=(n:number,u:string)=>`${n} ${n===1?u.replace(/s$/,''):u}`;

export function installWorkflowInspector(c:Controller,data:()=>InspectorData){
 const F={
  input:(label:string,value:unknown,onChange:(e:any)=>void,o:{ph?:string;hint?:string}={})=>({label,value:value ?? '',onChange,isInput:true,ph:o.ph || '',hint:o.hint || '',hasHint:!!o.hint,hasAi:false,hasCount:false}),
  text:(label:string,value:unknown,onChange:(e:any)=>void,o:{ph?:string;hint?:string}={})=>({label,value:value ?? '',onChange,isText:true,ph:o.ph || '',hint:o.hint || '',hasHint:!!o.hint,hasCount:false}),
  select:(key:string,label:string,value:unknown,opts:any[],onPick:(v:any)=>void,hint='',o?:any)=>({label,isSelect:true,dd:c.dd(key,value,opts,onPick,o),hint,hasHint:!!hint}),
  seg:(label:string,value:unknown,opts:[any,string][],onPick:(v:any)=>void,hint='')=>({label,isSeg:true,options:opts.map(o=>({l:o[1],style:seg(value===o[0]),onClick:()=>onPick(o[0])})),hint,hasHint:!!hint}),
  amount:(label:string,value:unknown,onChange:(e:any)=>void,unit:string,onUnit:(u:string)=>void,units=UNITS,hint='')=>({label,value,onChange,isAmount:true,options:units.map(u=>({l:u.charAt(0).toUpperCase()+u.slice(1),style:seg(unit===u),onClick:()=>onUnit(u)})),hint,hasHint:!!hint}),
  link:(label:string,text:string,href:string,hint='')=>({label,value:text,href,isLink:true,hint,hasHint:!!hint}),
 };
 const num=(e:any,min=0)=>Math.max(min,Number(e.target.value) || 0);

 /** Editable rule list: field, comparison, value, plus add/remove and all/any. */
 function ruleFields(key:string,rules:Rule[],set:(rules:Rule[])=>void,match:string,setMatch:(m:string)=>void){
  const out:any[]=[];
  rules.forEach((r,i)=>{
   const custom=r.field.startsWith('contact.attributes.')?'contact.attributes.':r.field.startsWith('context.')?'context.':r.field;
   const update=(patch:Partial<Rule>)=>set(rules.map((x,j)=>j===i?{...x,...patch}:x));
   out.push(F.select(`${key}f${i}`,`Rule ${i+1}`,custom,RULE_FIELDS.map(f=>[f[0],f[1],'',f[2]]),(v:string)=>update({field:v,...(v.startsWith('run.')?{op:'is_true',value:undefined}:{})}),'',{showSub:true}));
   if(custom.endsWith('.'))out.push(F.input(custom==='context.'?'Event data field':'Contact field name',r.field.slice(custom.length),(e:any)=>update({field:custom+e.target.value.replace(/[^A-Za-z0-9_.-]/g,'')}),{ph:custom==='context.'?'e.g. total, plan, appointment_at':'e.g. plan, birthday, lead_score'}));
   out.push(F.select(`${key}o${i}`,'Comparison',r.op,RULE_OPS.map(o=>[o[0],o[1]]),(v:string)=>update({op:v})));
   if(!NO_VALUE_OPS.includes(r.op))out.push(F.input('Value',r.value as any,(e:any)=>update({value:e.target.value}),{ph:['before','after'].includes(r.op)?'2026-12-31 or now-7d':['in','not_in'].includes(r.op)?'gold, platinum':'Value'}));
   out.push(F.seg('',null,[['x','Remove rule']],()=>set(rules.filter((_,j)=>j!==i))));
  });
  out.push(F.seg(rules.length?'':'No rules yet',null,[['add','+ Add rule']],()=>set([...rules,{field:'contact.tags',op:'contains',value:''}])));
  if(rules.length>1)out.push(F.seg('Match',match==='any'?'any':'all',[['all','All rules'],['any','Any rule']],setMatch));
  return out;
 }

 function triggerFields(w:any){
  const S=w.settings || {},cfg=w.tcfg || {},trig=triggerOf(w.tkey),d=data();
  const setCfg=(patch:any)=>c.change((x:any)=>({...x,tcfg:{...(x.tcfg || {}),...patch}}),{merge:'tcfg'});
  const fields:any[]=[F.select('trig','Start when',w.tkey,TRIGGERS.map(t=>[t.key,t.label,t.kind==='custom'?`Event: ${t.event}`:t.kind==='date'?'Daily, from a contact date':t.kind==='audience'?'When added to a list':t.kind==='api'?'API or manual enrollment':'Email engagement',t.group]),(k:string)=>c.change((x:any)=>({...x,tkey:k,tcfg:{}})),trig.hint || '',{showSub:true})];
  if(trig.kind==='custom'){
   fields.push(F.input('Event name',cfg.eventName ?? trig.event,(e:any)=>setCfg({eventName:slug(e.target.value)}),{hint:'Your system sends POST /v1/workflows/events with {"event", "email", "data"}. Data fields are available as context.<field> in rules and {{field}} in emails.'}));
   fields.push(...ruleFields('tf',cfg.filters || [],(filters)=>setCfg({filters}),'all',()=>undefined).map((f,i)=>i===0 && !(cfg.filters || []).length?{...f,label:'Only when the event data matches (optional)'}:f));
  }else if(trig.kind==='audience'){
   fields.push(F.select('tlist','List',cfg.list,d.lists.map(l=>[l.id,l.name]),(v:string)=>setCfg({list:v}),d.lists.length?'Contacts added to this list from now on enter the workflow.':'Create a list under Audience first.',{ph:'Choose a list…'}));
  }else if(trig.kind==='date'){
   const offset=Number(cfg.offsetDays ?? trig.offset ?? 0);
   fields.push(F.input('Contact date field',cfg.dateField ?? trig.dateField,(e:any)=>setCfg({dateField:slug(e.target.value)}),{hint:'A contact field holding a date as YYYY-MM-DD (set via the contacts API or Update contact). Use created_at for signup anniversaries.'}));
   fields.push(F.seg('Repeat',cfg.recurrence ?? trig.recurrence ?? 'yearly',[['yearly','Every year'],['once','Once, on the exact date']],(v:string)=>setCfg({recurrence:v})));
   fields.push(F.amount('Enter this many days',Math.abs(offset),(e:any)=>setCfg({offsetDays:(offset>0?1:-1)*num(e)}),offset>0?'after':'before',(u:string)=>setCfg({offsetDays:(u==='after'?1:-1)*Math.abs(offset)}),['before','after'],'0 enters on the date itself.'));
   fields.push(F.input('At hour (workspace time)',cfg.hour ?? 9,(e:any)=>setCfg({hour:Math.min(23,num(e))}),{hint:`0-23, in ${d.workspaceTz}.`}));
  }
  fields.push(F.select('aud','Who can enter',S.entry || (S.audience==='subscribed'?'subscribed':'all'),[['all','Everyone who triggers it'],['subscribed','Subscribed contacts only','Skips unsubscribed and suppressed contacts'],['rules','Contacts matching rules','Filter on tags, contact fields or event data']],(v:string)=>c.setSet({entry:v,audience:v==='subscribed'?'subscribed':'all'}),'',{showSub:true}));
  if(S.entry==='rules'){
   fields.push(...ruleFields('en',S.entryRules || [],(entryRules)=>c.setSet({entryRules}),S.entryMatch,(entryMatch)=>c.setSet({entryMatch})));
   fields.push(F.seg('Also require subscription',S.entrySubscribed?'y':'n',[['y','Yes'],['n','No']],(v:string)=>c.setSet({entrySubscribed:v==='y'})));
  }
  fields.push(F.select('reentry','Re-entry',S.reentry || 'once',[['once','Only once, ever','Best for welcome and onboarding'],['30d','Again after 30 days','Good for carts and browse'],['every','Every time it triggers','For transactional reminders and yearly dates']],(v:string)=>c.setSet({reentry:v}),'Nobody is ever in this workflow twice at the same time.',{showSub:true}));
  fields.push(F.select('goalT','Goal (exit when the contact…)',S.goal || 'none',GOALS.map(g=>[g.key,g.label,g.event?.startsWith('custom:')?`Event: ${g.event.slice(7)}`:'']),(v:string)=>c.setSet({goal:v}),'',{showSub:true}));
  if(S.goal==='custom')fields.push(F.input('Goal event name',S.goalEvent,(e:any)=>c.setSet({goalEvent:slug(e.target.value)}),{ph:'e.g. subscription_renewed'}));
  if(S.goal && S.goal!=='none')fields.push(F.seg('When the goal is reached',S.goalExit===false?'record':'exit',[['exit','Exit the workflow'],['record','Record and continue']],(v:string)=>c.setSet({goalExit:v==='exit'})));
  return fields;
 }

 function stepFields(s:any,w:any){
  const set=(p:any,mk?:string)=>c.setNode(s.id,p,mk),d=data(),fields:any[]=[];
  if(s.t==='email'){
   fields.push(F.select('tpl'+s.id,'Template',s.template,d.templates.map(t=>[t.id,t.name,t.subject || '']),(v:string)=>set({template:v}),d.templates.length?'':'No templates yet. Create one in the email builder.',{ph:'Choose a template…',showSub:true}));
   if(s.template)fields.push(F.link('','Edit this template',`/email-builder?id=${encodeURIComponent(s.template)}`));
   fields.push(F.input('Subject line (optional)',s.subject,(e:any)=>set({subject:e.target.value},'subj'),{ph:d.templates.find(t=>t.id===s.template)?.subject || 'Uses the template subject',hint:'Overrides the template subject for this step. Merge tags like {{first_name}} work.'}));
   fields.push(F.input('From address',s.from ?? d.from,(e:any)=>set({from:e.target.value.trim()},'from'),{hint:d.domains.length?`Verified domains: ${d.domains.join(', ')}`:'Verify a sending domain in Settings first.'}));
   fields.push(F.input('From name',s.fromName,(e:any)=>set({fromName:e.target.value},'fname'),{ph:'e.g. Acme Support'}));
   fields.push(F.input('Reply-to (optional)',s.replyTo,(e:any)=>set({replyTo:e.target.value.trim()},'reply'),{ph:'team@yourdomain.com'}));
   fields.push(F.link('','Create a new template','/email-builder','Unsubscribe link and postal address are added automatically. Suppressed contacts are skipped.'));
  }else if(s.t==='wait'){
   const mode=s.mode==='before'?'date':s.mode || 'duration';
   fields.push(F.select('wmode'+s.id,'Wait type',mode,[['duration','Delay','Wait a fixed amount of time'],['time','Time of day','Continue at a set local time'],['event','Until an event','Continue when they open, click or do something'],['date','Before or after a date','Appointments, renewals, trial ends, events']],(m:string)=>set({mode:m,...(m==='date' && !s.field?{field:`context.${TRIGGER_DATE_FIELDS[w.tkey] || 'date'}`,direction:'before',amount:1,unit:'days'}:{})}),'',{showSub:true}));
   if(mode==='duration')fields.push(F.amount('Wait for',s.amount ?? 1,(e:any)=>set({amount:num(e)},'amt'),s.unit || 'days',(u:string)=>set({unit:u})));
   if(mode==='time'){
    fields.push(F.input('Continue at',s.time || '09:00',(e:any)=>set({time:e.target.value},'time'),{ph:'09:00',hint:'24-hour time.'}));
    fields.push(F.select('wtz'+s.id,'Time zone',s.tz || 'contact',[['contact','Each contact’s time zone',`Falls back to ${d.workspaceTz}`],[d.workspaceTz,`Workspace (${d.workspaceTz})`],['UTC','UTC']],(v:string)=>set({tz:v}),'',{showSub:true}));
    const days:number[]=Array.isArray(s.days) && s.days.length?s.days:[0,1,2,3,4,5,6];
    fields.push(F.seg('On days',days.length===7?'all':days.length===5 && !days.includes(0) && !days.includes(6)?'weekdays':'custom',[['all','Every day'],['weekdays','Weekdays'],['weekend','Weekends']],(v:string)=>set({days:v==='weekdays'?[1,2,3,4,5]:v==='weekend'?[0,6]:[]})));
   }
   if(mode==='event'){
    fields.push(F.select('wev'+s.id,'Continue when they…',s.event || 'opened',[['opened','Open the previous email'],['clicked','Click the previous email'],['custom','Do something in your system (event)']],(v:string)=>set({event:v})));
    if(s.event==='custom')fields.push(F.input('Event name',s.eventName,(e:any)=>set({eventName:slug(e.target.value)},'evn'),{ph:'e.g. order_placed',hint:'Sent to POST /v1/workflows/events for this contact.'}));
    fields.push(F.amount('Wait at most',s.max ?? 3,(e:any)=>set({max:num(e)},'max'),'days',()=>undefined,['days'],'Continues as soon as it happens, or after this long, so nobody gets stuck. Add an If/else after this step to send different follow-ups.'));
   }
   if(mode==='date'){
    fields.push(F.input('Date field',s.field || '',(e:any)=>set({field:e.target.value.replace(/[^A-Za-z0-9_.-]/g,'')},'fld'),{ph:'context.appointment_at',hint:'context.<field> for event/API data, or contact.attributes.<field> for a contact date.'}));
    fields.push(F.seg('Direction',s.direction==='after'?'after':'before',[['before','Before the date'],['after','After the date']],(v:string)=>set({direction:v})));
    fields.push(F.amount('How long',s.amount ?? 1,(e:any)=>set({amount:num(e)},'amt'),s.unit || 'days',(u:string)=>set({unit:u})));
    fields.push(F.seg('If the date is missing or already passed',s.ifMissed==='exit'?'exit':'continue',[['continue','Continue now'],['exit','Exit the workflow']],(v:string)=>set({ifMissed:v})));
   }
  }else if(s.t==='branch' || s.t==='filter'){
   const rules=rulesOf(s);
   fields.push(F.select('pre'+s.id,s.t==='branch'?'Check whether the contact…':'Only continue if the contact…',null,RULE_PRESETS.map(p=>[p[0],p[1]]),(k:string)=>{const p=RULE_PRESETS.find(x=>x[0]===k)!;set({rules:k==='custom'?(rules.length?rules:[{field:'contact.tags',op:'contains',value:''}]):p[2].map(r=>({...r})),match:'all',cond:undefined,rule:undefined});},s.t==='branch'?'Matching contacts follow the green Yes dot.':'Everyone else leaves the workflow here.',{ph:'Quick pick…'}));
   fields.push(...ruleFields('r'+s.id,rules,(next)=>set({rules:next,cond:undefined,rule:undefined}),s.match,(m)=>set({match:m})));
  }else if(s.t==='split'){
   const pct=Number(s.pct ?? 50);
   fields.push(F.seg('Traffic split',[50,70,80,90].includes(pct)?String(pct):'custom',[['50','50 / 50'],['70','70 / 30'],['80','80 / 20'],['90','90 / 10']],(v:string)=>set({pct:Number(v)})));
   fields.push(F.input('Path A percentage',pct,(e:any)=>set({pct:Math.min(99,Math.max(1,num(e,1)))},'pct'),{hint:'Each contact is assigned once and stays on its path.'}));
  }else if(s.t==='update'){
   fields.push(F.select('act'+s.id,'Action',s.action || 'add_tag',[['add_tag','Add tags'],['remove_tag','Remove tags'],['stage','Set lifecycle stage'],['attribute','Set a contact field'],['subscribe','Mark as subscribed'],['unsubscribe','Unsubscribe from marketing']],(v:string)=>set({action:v})));
   if(['add_tag','remove_tag'].includes(s.action || 'add_tag'))fields.push(F.input('Tags',s.value,(e:any)=>set({value:e.target.value},'val'),{ph:'vip, re-engaged',hint:'Comma separated.'}));
   if(s.action==='stage')fields.push(F.input('Stage',s.value,(e:any)=>set({value:e.target.value},'val'),{ph:'lead, customer, churned'}));
   if(s.action==='attribute'){fields.push(F.input('Field name',s.key,(e:any)=>set({key:e.target.value.replace(/[^A-Za-z0-9_]/g,'')},'key'),{ph:'plan'}));fields.push(F.input('Value',s.value,(e:any)=>set({value:e.target.value},'val'),{ph:'gold (leave empty to clear)'}));}
   if(s.action==='unsubscribe')fields.push(F.seg('','info',[['info','Also suppresses the address and exits every workflow']],()=>undefined));
  }else if(s.t==='notify'){
   fields.push(F.input('Send alert to',s.to,(e:any)=>set({to:e.target.value},'to'),{ph:'sales@yourdomain.com, owner@yourdomain.com',hint:'Up to 5 addresses.'}));
   fields.push(F.input('Alert subject',s.subject ?? 'Workflow alert: {{email}}',(e:any)=>set({subject:e.target.value},'nsub')));
   fields.push(F.text('Message',s.msg,(e:any)=>set({msg:e.target.value},'msg'),{ph:'{{first_name}} from {{company}} just booked a demo. Call within 1 hour.',hint:'Merge tags: {{email}}, {{first_name}}, {{company}} and any event field.'}));
   fields.push(F.input('From address',s.from ?? (d.from?`alerts@${d.from.split('@')[1]}`:''),(e:any)=>set({from:e.target.value.trim()},'nfrom')));
  }else if(s.t==='webhook'){
   fields.push(F.input('URL',s.url,(e:any)=>set({url:e.target.value.trim()},'url'),{ph:'https://'}));
   fields.push(F.text('Extra JSON fields (optional)',s.payload,(e:any)=>set({payload:e.target.value},'pl'),{ph:'{"source":"workflow"}',hint:'Sent with the contact and run details as a signed POST. Failures retry up to 5 times and appear in the run history.'}));
  }else if(s.t==='sms'){
   fields.push(F.link('','SMS is not available yet','#','Replace this step with an email. Publishing is blocked while it remains.'));
  }
  return fields;
 }

 const label=c.label.bind(c);
 c.label=(s:any,w:any)=>{
  const d=data();
  if(s.t==='email'){const t=d.templates.find(x=>x.id===s.template);return t?[s.subject || t.name,s.subject?t.name:t.subject || 'Saved template']:[s.subject || 'Untitled email','No template chosen'];}
  if(s.t==='wait'){
   const mode=s.mode==='before'?'date':s.mode;
   if(mode==='time')return [`Until ${s.time || '09:00'}`,s.tz && s.tz!=='contact'?s.tz:'In their time zone'];
   if(mode==='event')return [s.event==='custom'?`Until “${s.eventName || '…'}”`:s.event==='clicked'?'Until they click':'Until they open',`Or continue after ${unitTxt(Number(s.max ?? 3),'days')}`];
   if(mode==='date')return [`${unitTxt(Number(s.amount ?? 1),s.unit || 'days')} ${s.direction==='after'?'after':'before'}`,(s.field || 'a date').replace(/^context\.|^contact\.attributes\./,'')];
   return [unitTxt(Number(s.amount ?? 1),s.unit || 'days'),'Then continue'];
  }
  if(s.t==='branch' || s.t==='filter'){
   const rules=rulesOf(s),first=rules[0],f=RULE_FIELDS.find(x=>first && (x[0]===first.field || (x[0].endsWith('.') && first.field.startsWith(x[0]))));
   const text=first?`${f?.[0].endsWith('.')?first.field.split('.').pop():f?.[1] || first.field} ${RULE_OPS.find(o=>o[0]===first.op)?.[1] || first.op}${first.value!==undefined && first.value!==''?` ${first.value}`:''}`:'Choose a rule';
   return [rules.length>1?`${text} +${rules.length-1}`:text,s.t==='branch'?'Yes / No':'Everyone else exits'];
  }
  if(s.t==='update')return [({add_tag:'Add tags',remove_tag:'Remove tags',stage:'Set stage',attribute:`Set ${s.key || 'field'}`,subscribe:'Subscribe',unsubscribe:'Unsubscribe'} as any)[s.action || 'add_tag']+(s.value && !['subscribe','unsubscribe'].includes(s.action)?` “${s.value}”`:''),'Contact profile'];
  if(s.t==='notify')return [s.to || 'No recipient',s.msg || 'Internal alert'];
  if(s.t==='webhook')return [`POST ${(s.url || '').replace(/^https?:\/\//,'') || '…'}`,'Signed, retried on failure'];
  return label(s,w);
 };
 const newNode=c.newNode.bind(c);
 c.newNode=(t:string)=>{
  const n=newNode(t);
  if(t==='email')return {...n,subject:'',preheader:'',from:''};
  if(t==='branch')return {...n,rules:[{field:'run.last_opened',op:'is_true'}],match:'all',cond:undefined};
  if(t==='filter')return {...n,rules:[{field:'contact.status',op:'eq',value:'Subscribed'}],match:'all',rule:undefined};
  if(t==='notify')return {...n,subject:'Workflow alert: {{email}}'};
  if(t==='webhook')return {...n,method:'POST',payload:''};
  return n;
 };

 /** Post-process the generated view values: inspector, settings and palette. */
 return (values:any)=>{
  const w=c.cur();if(!w)return values;
  const S=w.settings || {};
  if(c.state.sel==='trigger')values.sel={...values.sel,title:triggerOf(w.tkey).label,fields:triggerFields(w)};
  else if(c.state.sel){const node=c.getNode(w,c.state.sel);if(node)values.sel={...values.sel,fields:stepFields(node,w)};}
  const dd=c.dd.bind(c);
  values.settings=[
   {title:'Goal',rows:[{isSelect:true,label:'Exit when the contact…',dd:dd('goal',S.goal || 'none',GOALS.map(g=>[g.key,g.label]),(v:string)=>c.setSet({goal:v})),hasHint:true,hint:S.goal==='custom'?'Set the event name in the trigger panel.':'Uses the events your system sends. Converted contacts stop receiving this journey.'}]},
   {title:'Sending rules',rows:[
    {isToggle:true,label:'Quiet hours',hint:'Hold emails that would arrive in this period until it ends.',track:track(!!S.quiet),knob:knob(!!S.quiet),onClick:()=>c.setSet({quiet:!S.quiet})},
    ...(S.quiet?[{isPair:true,a:S.qFrom || '21:00',b:S.qTo || '08:00',onA:(e:any)=>c.setSet({qFrom:e.target.value}),onB:(e:any)=>c.setSet({qTo:e.target.value})}]:[]),
    {isSelect:true,label:'Time zone',dd:dd('tz',S.tz || 'contact',[['contact','Each contact’s time zone',`Falls back to ${data().workspaceTz}`],['workspace','Workspace time zone',data().workspaceTz]],(v:string)=>c.setSet({tz:v}),{showSub:true}),hasHint:false,hint:''},
    {isToggle:true,label:'Frequency cap',hint:'Counts marketing emails from all workflows and campaigns.',track:track(!!S.cap),knob:knob(!!S.cap),onClick:()=>c.setSet({cap:!S.cap})},
    ...(S.cap?[{isNum:true,value:S.capN ?? 3,suffix:'emails per 7 days',onChange:(e:any)=>c.setSet({capN:Math.max(1,parseInt(e.target.value,10) || 1)})}]:[]),
   ]},
   {title:'Compliance',rows:[
    {isToggle:true,label:'Exit when they unsubscribe or complain',hint:'Always on.',track:track(true),knob:knob(true),onClick:()=>c.toast('Required. This can’t be turned off.')},
    {isToggle:true,label:'Skip suppressed contacts',hint:'Always on. Suppressed contacts never receive workflow email.',track:track(true),knob:knob(true),onClick:()=>c.toast('Required. This can’t be turned off.')},
   ]},
  ];
  const keep=(item:any)=>item.label!=='Send SMS';
  values.palette=(values.palette || []).map((g:any)=>({...g,items:g.items.filter(keep)})).filter((g:any)=>g.items.length);
  for(const key of ['edgeMenu','linkMenu'])if(Array.isArray(values[key]))values[key]=values[key].map((g:any)=>({...g,items:g.items.filter(keep)})).filter((g:any)=>g.items.length);
  return values;
 };
}
