import {describe,expect,it} from 'vitest';
import {WorkflowDocument} from '@platform/shared';

const T={id:'11111111-1111-4111-8111-111111111111',name:'Welcome',subject:'Hi'};
describe('AI workflow draft document',()=>{
 it('builds nested branches and reports publish issues like the builder compiler',()=>{
  const w=new WorkflowDocument(null,[T]);
  w.build({trigger:'opened',steps:[{t:'email',template:T.id},{t:'branch',cond:'score',paths:[{steps:[{t:'wait',amount:1,unit:'days'}]},{steps:[]}]}]});
  expect(w.doc.graph.nodes.map(n=>n.t)).toEqual(['trigger','email','branch','wait']);
  expect(w.doc.graph.edges.filter(e=>e.port==='yes')).toHaveLength(1);
  expect(w.issues()).toEqual([]);expect(w.view()).toContain('send email “Welcome”');
  expect(()=>w.build({trigger:'opened',steps:[{t:'sms'}]})).toThrow(/not supported/);
  expect(w.doc.graph.nodes).toHaveLength(4);
  expect(()=>w.build({trigger:'subscribed',steps:[{t:'wait'}]})).toThrow(/trigger must be/);
  expect(()=>new WorkflowDocument(null,[T]).build({trigger:'event',steps:[{t:'email',template:'22222222-2222-4222-8222-222222222222'}]})).toThrow(/does not exist/);
 });
 it('inserts between steps, edits fields and removes steps without orphaning the graph',()=>{
  const w=new WorkflowDocument(null,[T]);w.build({trigger:'event',steps:[{t:'email',template:T.id},{t:'email',template:T.id}]});
  const [first,second]=w.doc.graph.nodes.slice(1);
  w.insert(first!.id,undefined,[{t:'wait',amount:2,unit:'days'}]);
  const wait=w.doc.graph.nodes.find(n=>n.t==='wait')!;
  expect(w.doc.graph.edges.some(e=>e.from===first!.id && e.to===wait.id)).toBe(true);expect(w.doc.graph.edges.some(e=>e.from===wait.id && e.to===second!.id)).toBe(true);
  expect(w.update(wait.id,{amount:5,unit:'hours'})).toBe('wait 5 hours');
  expect(w.remove(wait.id)).toBe('wait 5 hours');expect(w.doc.graph.edges.some(e=>e.from===first!.id && e.to===second!.id)).toBe(true);
  expect(()=>w.remove('trigger')).toThrow();expect(()=>w.update('nope',{})).toThrow(/does not exist/);
  w.insert(second!.id,undefined,[{t:'email'}]);expect(w.issues().join(' ')).toMatch(/choose a template/);
 });
});
