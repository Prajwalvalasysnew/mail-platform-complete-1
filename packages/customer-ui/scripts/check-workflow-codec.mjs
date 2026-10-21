// Quick smoke check of the builder codec the UI ships. The exhaustive suite is
// packages/tests/workflow-builder-codec.test.ts; this covers the mappings the UI relies on most.
import assert from 'node:assert/strict';
import {compileWorkflow} from '../src/faithful/workflow-codec.ts';
const document={tkey:'event',settings:{quiet:false,cap:false,goal:'none',reentry:'once',entry:'all'},graph:{nodes:[{id:'trigger',t:'trigger'},{id:'wait',t:'wait',mode:'duration',amount:1,unit:'minutes'}],edges:[{from:'trigger',to:'wait',port:'out'}]}};
const compile=value=>compileWorkflow(value,'hello@example.test');
const withSettings=settings=>compile({...document,settings:{...document.settings,...settings}}).settings;
const withNode=node=>compile({...document,graph:{...document.graph,nodes:[document.graph.nodes[0],{id:'wait',...node}]}});
assert.equal(compile(document).steps[0].duration_seconds,60);
// Sending rules and goals compile to engine settings.
assert.equal(withSettings({reentry:'30d'}).reentry_cooldown_seconds,2592000);
assert.deepEqual(withSettings({quiet:true,qFrom:'21:00',qTo:'08:00',tz:'contact'}).send_window,{start:'08:00',end:'21:00',timezone:'contact'});
assert.equal(withSettings({cap:true,capN:3}).frequency_cap.max,3);
assert.throws(()=>withSettings({cap:true,capN:0}));
assert.equal(compile({...document,settings:{...document.settings,goal:'click'}}).goal.event_type,'clicked');
// Steps: overrides are allowed; unsupported channels and impossible waits are rejected.
assert.equal(withNode({t:'wait',mode:'event',event:'clicked',max:2}).steps[0].timeout_seconds,172800);
for(const node of [{t:'sms'},{t:'wait',mode:'duration',unit:'days',amount:-1},{t:'wait',mode:'duration',unit:'minutes',amount:0},{t:'wait',mode:'event',event:'opened',max:0}])assert.throws(()=>withNode(node),JSON.stringify(node));
assert.throws(()=>compile({...document,graph:{...document.graph,edges:[...document.graph.edges,...document.graph.edges]}}));
console.log('PASS workflow codec mappings, sending rules and rejections');
