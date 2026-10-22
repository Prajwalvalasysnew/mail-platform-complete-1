import {describe,expect,it} from 'vitest';
import {compileWorkflowDetailed,validateWorkflowDefinition,simulateWorkflow,TRIGGERS,RULE_PRESETS,evaluateRule,type CompileContext} from '@platform/shared';

const T='11111111-1111-4111-8111-111111111111',LIST='22222222-2222-4222-8222-222222222222';
const ctx:CompileContext={from:'hello@acme.test',domains:['acme.test'],templates:[T],workspaceTz:'Europe/London'};
const settings={reentry:'once',goal:'none',quiet:false,cap:false,entry:'all'};
function doc(nodes:any[],edges:[string,string,string?][],extra:any={}){
 return {name:'w',tkey:'order',tcfg:{},settings,...extra,graph:{nodes:[{id:'trigger',t:'trigger'},...nodes],edges:edges.map(([from,to,port],i)=>({id:`e${i}`,from,to,port:port || 'out'}))}};
}
const strict=(def:any)=>{const v=validateWorkflowDefinition(def,{strict:true});expect(v.errors).toEqual([]);return v.definition!;};

describe('workflow builder codec',()=>{
 it('compiles every step type into a strictly valid engine definition',()=>{
  const {definition,issues}=compileWorkflowDetailed(doc([
   {id:'mail',t:'email',template:T,subject:'Hi {{first_name}}',fromName:'Acme',replyTo:'help@acme.test'},
   {id:'w1',t:'wait',mode:'duration',amount:2,unit:'hours'},
   {id:'w2',t:'wait',mode:'time',time:'09:30',tz:'contact',days:[1,2,3,4,5]},
   {id:'w3',t:'wait',mode:'event',event:'custom',eventName:'Order Shipped',max:5},
   {id:'w4',t:'wait',mode:'before',field:'context.appointment_at',amount:1,unit:'days',ifMissed:'exit'},
   {id:'b',t:'branch',rules:[{field:'contact.tags',op:'contains',value:'vip'},{field:'contact.attributes.spend',op:'gte',value:'100'}],match:'any'},
   {id:'tag',t:'update',action:'add_tag',value:'VIP, loyal'},
   {id:'stage',t:'update',action:'attribute',key:'tier',value:'2'},
   {id:'s',t:'split',pct:70},
   {id:'n',t:'notify',to:'a@acme.test; b@acme.test',msg:'Big spender {{email}}'},
   {id:'h',t:'webhook',url:'https://hooks.acme.test/x',payload:'{"source":"wf"}'},
   {id:'f',t:'filter',cond:'vip'},
  ],[['trigger','mail'],['mail','w1'],['w1','w2'],['w2','w3'],['w3','w4'],['w4','b'],['b','tag','yes'],['b','stage','no'],['tag','s'],['s','n','a'],['s','h','b'],['stage','f']]),ctx);
  expect(issues.filter(i=>i.level==='error')).toEqual([]);
  const def=strict(definition);
  const by=Object.fromEntries(def.steps.map((s:any)=>[s.id,s]));
  expect(def.trigger).toEqual({type:'custom_event',event_name:'order_placed'});
  expect(by.mail).toMatchObject({type:'send_email',template_id:T,from:'hello@acme.test',from_name:'Acme',reply_to:'help@acme.test',subject:'Hi {{first_name}}'});
  expect(by.w1).toMatchObject({type:'delay',duration_seconds:7200});
  expect(by.w2).toMatchObject({type:'wait_until',mode:'time_of_day',time:'09:30',timezone:'contact',days:[1,2,3,4,5]});
  expect(by.w3).toMatchObject({type:'wait_for_event',event_types:['custom:order_shipped'],timeout_seconds:5*86400,scope:'any'});
  expect(by.w4).toMatchObject({type:'wait_until',mode:'field',field:'context.appointment_at',offset_seconds:-86400,if_missed:'exit'});
  expect(by.b).toMatchObject({type:'condition',match:'any',rules:[{field:'contact.tags',op:'contains',value:'vip'},{field:'contact.attributes.spend',op:'gte',value:100}]});
  expect(by.tag).toMatchObject({type:'update_contact',add_tags:['vip','loyal']});
  expect(by.stage).toMatchObject({type:'update_contact',set_attributes:{tier:2}});
  expect(by.s).toMatchObject({type:'split',percent_a:70,branch_a:'n',branch_b:'h'});
  expect(by.n).toMatchObject({type:'notify',to:['a@acme.test','b@acme.test'],from:'alerts@acme.test'});
  expect(by.h).toMatchObject({type:'webhook',payload:{source:'wf'}});
  expect(by.f).toMatchObject({type:'condition',rules:[{field:'contact.tags',op:'contains',value:'vip'}],on_false:null});
  expect(def.settings.default_timezone).toBe('Europe/London');
 });

 it('maps every industry trigger and the workflow settings',()=>{
  for(const t of TRIGGERS){
   const tcfg=t.kind==='audience'?{list:LIST}:{};
   const {definition,issues}=compileWorkflowDetailed(doc([{id:'w',t:'wait',mode:'duration',amount:1,unit:'days'}],[['trigger','w']],{tkey:t.key,tcfg}),ctx);
   expect(issues.filter(i=>i.level==='error'),t.key).toEqual([]);
   const def=strict(definition);
   const expected={email:'event',custom:'custom_event',audience:'audience',date:'date',api:'api'}[t.kind];
   expect(def.trigger.type,t.key).toBe(expected);
  }
  const {definition}=compileWorkflowDetailed(doc([{id:'w',t:'wait',mode:'duration',amount:1,unit:'days'}],[['trigger','w']],{tkey:'date',tcfg:{dateField:'Renewal Date',offsetDays:-7,recurrence:'once',hour:8},
   settings:{reentry:'30d',goal:'custom',goalEvent:'renewed',goalExit:false,quiet:true,qFrom:'21:00',qTo:'08:00',tz:'workspace',cap:true,capN:4,entry:'rules',entryRules:[{field:'contact.status',op:'eq',value:'Subscribed'}],entrySubscribed:true}}),ctx);
  const def=strict(definition);
  expect(def.trigger).toEqual({type:'date',field:'contact.attributes.renewal_date',offset_days:-7,recurrence:'once',hour:8,timezone:'Europe/London'});
  expect(def.goal).toEqual({event_type:'custom:renewed',exit_on_goal:false});
  expect(def.settings).toMatchObject({allow_reentry:true,reentry_cooldown_seconds:30*86400,send_window:{start:'08:00',end:'21:00',timezone:'Europe/London'},frequency_cap:{max:4,days:7},entry:{require_subscribed:true,rules:[{field:'contact.status',op:'eq',value:'Subscribed'}]}});
 });

 it('reports precise issues on the step that needs fixing instead of failing silently',()=>{
  const {definition,issues}=compileWorkflowDetailed(doc([
   {id:'mail',t:'email',template:'',from:'x@unverified.test'},
   {id:'sms',t:'sms',text:'hi'},
   {id:'b',t:'branch',rules:[{field:'contact.attributes.',op:'eq'}]},
   {id:'n',t:'notify',to:'not-an-email',msg:''},
   {id:'h',t:'webhook',url:'http://plain.test'},
   {id:'lost',t:'wait',mode:'duration',amount:0,unit:'days'},
  ],[['trigger','mail'],['mail','sms'],['sms','b'],['b','n','yes'],['n','h']],{tkey:'subscribed'}),ctx);
  expect(definition).toBeNull();
  const of=(id:string)=>issues.filter(i=>i.id===id).map(i=>i.text).join(' | ');
  expect(of('trigger')).toMatch(/Choose the list/);
  expect(of('mail')).toMatch(/Choose an email template.*verified domain/);
  expect(of('sms')).toMatch(/SMS is not available/);
  expect(of('b')).toMatch(/needs a field name.*needs a value/);
  expect(of('n')).toMatch(/must be email addresses.*alert message/);
  expect(of('h')).toMatch(/https/);
  expect(of('lost')).toMatch(/Not connected/);
 });

 it('upgrades legacy preset conditions and simulates the compiled journey',()=>{
  for(const [key] of RULE_PRESETS.filter(p=>!['custom','tag'].includes(p[0]))){
   const {issues}=compileWorkflowDetailed(doc([{id:'b',t:'branch',cond:key}],[['trigger','b']]),ctx);
   expect(issues.filter(i=>i.level==='error'),key).toEqual([]);
  }
  const {definition}=compileWorkflowDetailed(doc([{id:'b',t:'branch',rules:[{field:'run.last_opened',op:'is_true'}]},{id:'yes',t:'update',action:'add_tag',value:'engaged'},{id:'no',t:'email',template:T}],[['trigger','b'],['b','yes','yes'],['b','no','no']]),ctx);
  expect(simulateWorkflow(strict(definition),{run_opened:false}).path.map(p=>p.step_id)).toEqual(['b','no']);
 });

 it('evaluates the new comparison operators',()=>{
  const bag={contact:{tags:['VIP'],email:'ada@acme.test',attributes:{renewal:'2026-01-01',active:'yes'}}};
  const now=new Date('2026-06-01T00:00:00Z');
  expect(evaluateRule(bag,{field:'contact.tags',op:'contains',value:'vip'})).toBe(true);
  expect(evaluateRule(bag,{field:'contact.email',op:'ends_with',value:'@ACME.test'})).toBe(true);
  expect(evaluateRule(bag,{field:'contact.email',op:'in',value:'x@y.z, ada@acme.test'})).toBe(true);
  expect(evaluateRule(bag,{field:'contact.attributes.active',op:'is_true'})).toBe(true);
  expect(evaluateRule(bag,{field:'contact.attributes.renewal',op:'before',value:'now'},now)).toBe(true);
  expect(evaluateRule(bag,{field:'contact.attributes.renewal',op:'after',value:'now-200d'},now)).toBe(true);
  expect(evaluateRule(bag,{field:'contact.attributes.renewal',op:'after',value:'now-100d'},now)).toBe(false);
 });
});
