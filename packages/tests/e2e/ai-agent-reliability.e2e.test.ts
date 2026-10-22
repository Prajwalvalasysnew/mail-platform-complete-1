/** How the agent behaves when a real model or provider misbehaves, on the real DeepSeek Harness
 * runtime with a scripted model: stringified arguments, half-finished plans, provider failures,
 * slow turns, replies cut off at the output cap, and claims of changes that never happened.
 */
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {db,createUserSession,executeAiRun,withTenant,setAgentRuntime} from '@platform/shared';
import {createHarnessRuntime} from '@platform/worker/ai-harness.js';
import {startFakeAgentLlm,lastUserText,toolResults,type FakeScript} from '../fixtures/fake-agent-llm.js';

const app=Fastify(),actors:{cid:string;uid:string;token:string}[]=[];
let llm:Awaited<ReturnType<typeof startFakeAgentLlm>>,script:FakeScript=()=>({content:'ok'});
async function actor(){
 const email=`reliability-${randomUUID()}@example.test`,c=await db.insertInto('customers').values({email,name:'Reliability'}).returning('id').executeTakeFirstOrThrow(),u=await db.insertInto('users').values({email}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:'owner'}).execute();
 const s=await createUserSession(u.id,{currentCustomerId:c.id}),a={cid:c.id,uid:u.id,token:s.token};actors.push(a);
 await withTenant(a.cid,trx=>trx.insertInto('sending_domains').values({customer_id:a.cid,domain:`r-${a.cid.slice(0,8)}.example.test`,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true}).execute());
 return a;
}
async function turn(a:any,instruction:string,operation='assist',settings:Record<string,unknown>={}){
 const r=await app.inject({method:'POST',url:`/ai/chats/${randomUUID()}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation,instruction,settings}});
 expect(r.statusCode,r.body).toBe(202);
 await executeAiRun(a.cid,r.json().id,new AbortController().signal);
 const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',r.json().id).executeTakeFirstOrThrow());
 return {run,result:run.result as any};
}
const prompts=()=>llm.requests.flatMap(r=>r.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)));
const b=(type:string,text:string,url?:string)=>({type,text,...(url?{url}:{})});
const EMAIL={key:'hello',name:'Hello',subject:'Hello there',blocks:[b('heading','Hello there'),b('paragraph','A short note.')]};

beforeAll(async()=>{
 llm=await startFakeAgentLlm(request=>script(request));
 // A reasoning-model name: the harness must send the effort and the output cap Ollama reads.
 for(const [k,v] of Object.entries({AI_ENABLED:'true',AI_ENABLED_TENANTS:'*',AI_BASE_URL:llm.baseUrl,AI_MODEL:'gpt-oss:fixture'}))vi.stubEnv(k,v);
 setAgentRuntime(await createHarnessRuntime());
 await app.register(accountAiRoutes,{prefix:'/ai'});await app.ready();
},60000);
afterEach(()=>{vi.stubEnv('AI_AGENT_TIMEOUT_MS','');llm.requests.length=0;});
afterAll(async()=>{setAgentRuntime(undefined);vi.unstubAllEnvs();await app.close();await llm.close();for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}});

describe('agent reliability with imperfect models',()=>{
 it('sends Ollama the output cap and reasoning effort it reads',async()=>{
  const a=await actor();script=()=>({content:'Hi! How can I help?'});
  const {run}=await turn(a,'Hello');
  expect(run.status,String(run.error)).toBe('completed');
  const body=llm.requests[0]!.body;
  expect(body.max_tokens).toBe(8192);expect(body.max_completion_tokens).toBeUndefined();
  expect(body.reasoning_effort).toBe('medium');
 },90000);

 it('accepts arguments sent as JSON strings and numbers as strings',async()=>{
  const a=await actor();
  script=({messages})=>toolResults(messages).length?{content:'Built the campaign.'}:{calls:[
   {name:'define_audience',arguments:{name:'Everyone recent',rules:JSON.stringify([{field:'Created',op:'in last',val:'30 days'}])}},
   {name:'draft_campaign_email',arguments:{...EMAIL,blocks:JSON.stringify(EMAIL.blocks)}},
   {name:'build_workflow',arguments:{name:'Hello flow',trigger:'api',steps:JSON.stringify([{t:'email',template:'draft:hello'},{t:'wait',mode:'duration',amount:'3',unit:'days'}])}},
  ]};
  const {run,result}=await turn(a,'Send a hello campaign to recent contacts');
  expect(run.status,String(run.error)).toBe('completed');
  expect(result.operation).toBe('campaign');expect(result.emails).toHaveLength(1);
  expect(result.workflow.document.graph.nodes.find((n:any)=>n.t==='wait').amount).toBe(3);
 },90000);

 it('asks the model to finish a half-built campaign',async()=>{
  const a=await actor();
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages);
   if(/^Completeness check/.test(ask))return results.length?{content:'Done: audience, email and journey are ready.'}:{calls:[{name:'build_workflow',arguments:{name:'Hello flow',trigger:'api',steps:[{t:'email',template:'draft:hello'}]}}]};
   return results.length?{content:'I defined the audience and wrote the email.'}:{calls:[{name:'define_audience',arguments:{name:'Recent',rules:[{field:'Created',op:'in last',val:'7 days'}]}},{name:'draft_campaign_email',arguments:EMAIL}]};
  };
  const {result}=await turn(a,'Send a hello campaign to recent contacts');
  expect(prompts().some(p=>/^Completeness check: this campaign is still missing its journey/.test(p))).toBe(true);
  expect(result.workflow.document.graph.nodes.map((n:any)=>n.t)).toEqual(['trigger','email']);
  expect(result.message).toBe('Done: audience, email and journey are ready.');
 },90000);

 it('keeps finished work when the provider fails mid-turn',async()=>{
  const a=await actor();
  script=({messages})=>toolResults(messages).length?{status:500}:{calls:[{name:'define_audience',arguments:{name:'Recent',rules:[{field:'Created',op:'in last',val:'7 days'}]}},{name:'draft_campaign_email',arguments:EMAIL}]};
  const {run,result}=await turn(a,'Send a hello campaign to recent contacts');
  expect(run.status,String(run.error)).toBe('completed');
  expect(result.operation).toBe('campaign');expect(result.emails).toHaveLength(1);
  expect(result.message).toMatch(/stopped responding before I finished/);
 },180000);

 it('stops before the deadline and keeps what a slow model finished',async()=>{
  const a=await actor();vi.stubEnv('AI_AGENT_TIMEOUT_MS','1000');
  script=({messages})=>toolResults(messages).length?{content:'too late',delayMs:60000}:{calls:[{name:'define_audience',arguments:{name:'Recent',rules:[{field:'Created',op:'in last',val:'7 days'}]}},{name:'draft_campaign_email',arguments:EMAIL}]};
  const started=Date.now(),{run,result}=await turn(a,'Send a hello campaign to recent contacts');
  expect(run.status,String(run.error)).toBe('completed');expect(Date.now()-started).toBeLessThan(30000);
  expect(result.message).toMatch(/ran out of time before finishing/);expect(result.emails).toHaveLength(1);
 },90000);

 it('recovers when a reply is cut off at the output cap',async()=>{
  const a=await actor();
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages);
   if(/hit the output length limit/.test(ask))return results.length?{content:'Wrote the email.'}:{calls:[{name:'draft_campaign_email',arguments:EMAIL},{name:'define_audience',arguments:{name:'Recent',rules:[{field:'Created',op:'in last',val:'7 days'}]}},{name:'build_workflow',arguments:{name:'Hello flow',trigger:'api',steps:[{t:'email',template:'draft:hello'}]}}]};
   return {content:'{"key":"hello","blocks":[{"type":"heading","text":"Hel',finish:'length'};
  };
  const {run,result}=await turn(a,'Send a hello campaign to recent contacts');
  expect(run.status,String(run.error)).toBe('completed');
  expect(prompts().some(p=>/hit the output length limit/.test(p))).toBe(true);
  expect(result.operation).toBe('campaign');expect(result.emails[0].key).toBe('hello');
 },90000);

 it('treats an empty record id as none and allows re-reading after an edit',async()=>{
  const a=await actor();let reads=0;
  script=({messages})=>{
   const results=toolResults(messages);
   if(!results.length)return {calls:[{name:'read_workspace',arguments:{tool:'list_templates',id:'',query:''}}]};
   if(/Invalid arguments/.test(results.join('')))throw new Error('empty id was rejected');
   reads++;return {content:'You have no templates yet.'};
  };
  const {result}=await turn(a,'Which templates do I have?');
  expect(reads).toBe(1);expect(result).toMatchObject({operation:'chat',text:'You have no templates yet.'});
 },90000);

 it('never shows a claimed change that no tool made',async()=>{
  const a=await actor();script=()=>({content:"I've added a bright orange button to your email."});
  const {result}=await turn(a,'Add an orange button','editor',{editor:{key:randomUUID(),content:'',subject:'',preheader:'',html:'<p>Hi</p>',tone:'Professional'}});
  expect(result.operation).toBe('chat');
  expect(result.text).toMatch(/^I could not complete that change/);
 },90000);
});
