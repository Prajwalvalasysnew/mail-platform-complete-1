import {describe,expect,it} from 'vitest';
import {WorkflowDocument} from '@platform/shared';

const T={id:'11111111-1111-4111-8111-111111111111',name:'Welcome',subject:'Hi'};
const ws={templates:[T],domains:['acme.test'],lists:[{id:'22222222-2222-4222-8222-222222222222',name:'Newsletter'}],timezone:'UTC'};
describe('AI workflow draft document',()=>{
 it('builds industry workflows with nested branches and reports publish issues from the shared codec',()=>{
  const w=new WorkflowDocument(null,ws);
  w.build({trigger:'appt',trigger_config:{event_name:'appointment_booked'},steps:[
   {t:'email',template:T.id},
   {t:'wait',mode:'date',field:'context.appointment_at',direction:'before',amount:1,unit:'days'},
   {t:'branch',preset:'opened',paths:[{steps:[{t:'update',action:'add_tag',value:'engaged'}]},{steps:[{t:'notify',to:['front-desk@acme.test'],msg:'Call {{email}}'}]}]},
  ]});
  expect(w.doc.graph.nodes.map(n=>n.t)).toEqual(['trigger','email','wait','branch','update','notify']);
  expect(w.doc.graph.edges.filter(e=>e.port==='yes')).toHaveLength(1);
  expect(w.issues()).toEqual([]);
  expect(w.view()).toContain('send email “Welcome”');
  expect(()=>w.build({trigger:'appt',steps:[{t:'sms'}]})).toThrow(/not supported/);
  expect(w.doc.graph.nodes).toHaveLength(6);
  expect(()=>w.build({trigger:'subscribed_maybe',steps:[{t:'wait'}]})).toThrow(/trigger must be/);
  expect(()=>new WorkflowDocument(null,ws).build({trigger:'event',steps:[{t:'email',template:'33333333-3333-4333-8333-333333333333'}]})).toThrow(/does not exist/);
  expect(()=>new WorkflowDocument(null,ws).build({trigger:'subscribed',trigger_config:{list_id:'44444444-4444-4444-8444-444444444444'},steps:[{t:'wait'}]})).toThrow(/List .* does not exist/);
 });
 it('inserts between steps, edits fields, removes steps and edits settings',()=>{
  const w=new WorkflowDocument(null,ws);w.build({trigger:'event',steps:[{t:'email',template:T.id},{t:'email',template:T.id}]});
  const [first,second]=w.doc.graph.nodes.slice(1);
  w.insert(first!.id,undefined,[{t:'wait',amount:2,unit:'days'}]);
  const wait=w.doc.graph.nodes.find(n=>n.t==='wait')!;
  expect(w.doc.graph.edges.some(e=>e.from===first!.id && e.to===wait.id)).toBe(true);expect(w.doc.graph.edges.some(e=>e.from===wait.id && e.to===second!.id)).toBe(true);
  expect(w.update(wait.id,{amount:5,unit:'hours'})).toBe('wait 5 hours');
  expect(w.remove(wait.id)).toBe('wait 5 hours');expect(w.doc.graph.edges.some(e=>e.from===first!.id && e.to===second!.id)).toBe(true);
  expect(()=>w.remove('trigger')).toThrow();expect(()=>w.update('nope',{})).toThrow(/does not exist/);
  w.insert(second!.id,undefined,[{t:'email'}]);expect(w.issues().join(' ')).toMatch(/Choose an email template/);
  expect(w.settings({goal_event:'order_placed',frequency_cap:2,quiet_hours:{from:'22:00',to:'07:00'},entry:'subscribed'})).toEqual(['goal event order_placed','entry subscribed','quiet hours 22:00-07:00','frequency cap 2 per 7 days']);
  expect(w.trigger('subscribed',{list_id:ws.lists[0]!.id})).toBe('Contact joins a list');
 });
 it('only sends webhooks and alerts to destinations the user supplied or the workflow already had',()=>{
  const w=new WorkflowDocument({graph:{nodes:[{id:'trigger',t:'trigger'},{id:'h1',t:'webhook',url:'https://hooks.acme.test/in',method:'POST',payload:''}],edges:[{id:'e1',from:'trigger',to:'h1',port:'out'}]}} as any,ws);
  w.restrictDestinations(new Set(['mailto:ops@acme.test']));
  expect(()=>w.insert('h1','out',[{t:'webhook',url:'https://attacker.example/collect'}])).toThrow(/not provided by the user/);
  expect(()=>w.insert('h1','out',[{t:'notify',to:'attacker@example.com',msg:'x'}])).toThrow(/not provided by the user/);
  w.insert('h1','out',[{t:'notify',to:'ops@acme.test',msg:'New lead {{email}}'},{t:'webhook',url:'https://hooks.acme.test/in'}]);
 });
 it('applies workflow settings all-or-nothing',()=>{
  const w=new WorkflowDocument(null,ws),before=w.snapshot();
  expect(()=>w.settings({goal:'click',reentry:'sometimes'})).toThrow(/reentry/);
  expect(w.snapshot()).toBe(before);
 });
});
