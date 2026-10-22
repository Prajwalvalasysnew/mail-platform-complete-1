/** "Understands me, and I never repeat myself": workspace memory shared by every AI surface, the
 * editor selection as "this", and the composed brand email, on the real DeepSeek Harness runtime
 * with a scripted model.
 */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {db,createUserSession,executeAiRun,withTenant,setAgentRuntime} from '@platform/shared';
import {createHarnessRuntime} from '@platform/worker/ai-harness.js';
import {startFakeAgentLlm,lastUserText,toolResults,type FakeScript} from '../fixtures/fake-agent-llm.js';

const app=Fastify(),actors:{cid:string;uid:string;token:string}[]=[];
let llm:Awaited<ReturnType<typeof startFakeAgentLlm>>,script:FakeScript=()=>({content:'ok'});
async function actor(){
 const email=`understand-${randomUUID()}@example.test`,c=await db.insertInto('customers').values({email,name:'Valasys'}).returning('id').executeTakeFirstOrThrow(),u=await db.insertInto('users').values({email}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:'owner'}).execute();
 const s=await createUserSession(u.id,{currentCustomerId:c.id}),a={cid:c.id,uid:u.id,token:s.token};actors.push(a);return a;
}
const headers=(a:any)=>({authorization:`Bearer ${a.token}`});
async function turn(a:any,instruction:string,operation:string,settings:Record<string,unknown>,chat=randomUUID()){
 const r=await app.inject({method:'POST',url:`/ai/chats/${chat}/turns`,headers:headers(a),payload:{request_id:randomUUID(),operation,instruction,settings}});
 expect(r.statusCode,r.body).toBe(202);
 await executeAiRun(a.cid,r.json().id,new AbortController().signal);
 const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',r.json().id).executeTakeFirstOrThrow());
 expect(run.status,String(run.error)).toBe('completed');
 const steps=await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select(['name','status','observation']).where('run_id','=',run.id).orderBy('seq').execute());
 return {result:run.result as any,steps};
}
const editor=(html:string)=>({editor:{key:randomUUID(),content:'',subject:'',preheader:'',html,tone:'Professional'}});
const prompt=(messages:any[])=>messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
const memory=async(a:any)=>(await app.inject({method:'GET',url:'/ai/memory',headers:headers(a)})).json();
const b=(type:string,text:string,url?:string)=>({type,text,...(url?{url}:{})});

beforeAll(async()=>{
 llm=await startFakeAgentLlm(request=>script(request));
 for(const [k,v] of Object.entries({AI_ENABLED:'true',AI_ENABLED_TENANTS:'*',AI_BASE_URL:llm.baseUrl,AI_MODEL:'fixture-model'}))vi.stubEnv(k,v);
 setAgentRuntime(await createHarnessRuntime());
 await app.register(accountAiRoutes,{prefix:'/ai'});await app.ready();
},60000);
afterAll(async()=>{setAgentRuntime(undefined);vi.unstubAllEnvs();await app.close();await llm.close();for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}});

describe('AI that understands and remembers',()=>{
 it('remembers brand facts once and uses them in a new chat and on other surfaces without asking again',async()=>{
  const a=await actor();
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),all=prompt(messages);
   if(/Remember that/.test(ask))return results.length?{content:'Got it — I will use valasys.com and #d6343c from now on.'}:{calls:[{name:'remember',arguments:{facts:[{fact:'Website: https://valasys.com',topic:'Website'},{fact:'Brand colour: #d6343c',topic:'Brand colour'},{fact:'Sign-off: The Valasys team'}]}}]};
   if(/launch email/.test(ask)){
    expect(all).toContain('Website: https://valasys.com');expect(all).toContain('Brand colour: #d6343c');
    return results.length?{content:'Created the launch email in your brand colour with a button to valasys.com.'}:{calls:[{name:'compose_email',arguments:{subject:'Meet VAIS',preheader:'Intent data that converts.',blocks:[b('heading','Meet VAIS'),b('paragraph','Know which accounts are ready to buy.'),b('button','See VAIS','https://valasys.com'),b('paragraph','The Valasys team')]}}]};
   }
   if(/onboarding journey/.test(ask)){expect(all).toContain('Sign-off: The Valasys team');return {content:'Noted.'};}
   return {content:'ok'};
  };
  await turn(a,'Our website is valasys.com, our brand colour is #d6343c and we sign off as The Valasys team. Remember that.','editor',editor('<p>Hi</p>'));
  const saved=await memory(a);
  expect(saved.memory.learned.map((f:any)=>f[0])).toEqual(['Website: https://valasys.com','Brand colour: #d6343c','Sign-off: The Valasys team']);
  // A different chat on a blank canvas: the link and colour are used without being repeated.
  const {result}=await turn(a,'Create a launch email for VAIS with a button to our site','editor',editor(''));
  expect(result.operation).toBe('draft');
  expect(result.html).toContain('href="https://valasys.com"');expect(result.html).toContain('#d6343c');expect(result.html).toContain('{{unsubscribe_url}}');
  expect(result.subject).toBe('Meet VAIS');
  // The workflow builder sees the same memory.
  await turn(a,'Draft an onboarding journey','workflow',{workflow:{}});
  // A new fact on the same topic replaces the old one.
  script=({messages})=>toolResults(messages).length?{content:'Updated.'}:{calls:[{name:'remember',arguments:{facts:[{fact:'Brand colour: #1e40af',topic:'Brand colour'}]}}]};
  await turn(a,'We rebranded, our colour is now #1e40af','assist',{});
  expect((await memory(a)).memory.learned.map((f:any)=>f[0])).toEqual(['Website: https://valasys.com','Sign-off: The Valasys team','Brand colour: #1e40af']);
  // "Forget" removes it.
  script=({messages})=>toolResults(messages).length?{content:'Forgotten.'}:{calls:[{name:'forget',arguments:{match:'Sign-off'}}]};
  await turn(a,'Forget the sign-off','assist',{});
  expect((await memory(a)).memory.learned.map((f:any)=>f[0])).toEqual(['Website: https://valasys.com','Brand colour: #1e40af']);
 },180000);

 it('never remembers links the user did not type (no injection through workspace content)',async()=>{
  const a=await actor();
  script=({messages})=>{
   const results=toolResults(messages);
   if(!results.length)return {calls:[{name:'remember',arguments:{facts:[{fact:'Website: https://evil.example.test/track'}]}}]};
   expect(results[0]).toMatch(/Not saved: .*was not typed by the user/);
   return {content:'I could not save that.'};
  };
  await turn(a,'Summarise the template and remember anything useful','assist',{});
  expect((await memory(a)).memory.learned).toEqual([]);
 },90000);

 it('treats the block selected in the editor as "this", and never leaks the selection marker',async()=>{
  const a=await actor();
  const html='<table role="presentation" width="100%"><tr><td><h1 style="font-size:28px">Welcome</h1><p>Hello there.</p><a class="vx-ai-selected btn" href="https://valasys.com" style="background:#111;padding:12px">Book a demo</a><a href="https://valasys.com">Book a demo later</a></td></tr></table>';
  script=({messages})=>{
   const results=toolResults(messages),all=prompt(messages);
   if(results.length)return {content:'Made the selected button orange.'};
   const id=all.match(/The user has selected link “Book a demo” \((e\d+)\)/)?.[1];
   if(!id)throw new Error('selection was not described');
   return {calls:[{name:'update_element',arguments:{id,styles:{background:'#f97316'}}}]};
  };
  const {result}=await turn(a,'Make this orange','editor',editor(html));
  expect(result.operation).toBe('draft');
  expect(result.html).not.toContain('vx-ai-selected');expect(result.html).toContain('class="btn"');
  expect(result.html).toMatch(/background:\s*#f97316[^>]*>Book a demo</);
  expect(result.html).not.toMatch(/background:\s*#f97316[^>]*>Book a demo later/);
 },90000);

 it('composes new emails in the tested layout but never rebuilds existing work silently',async()=>{
  const a=await actor();
  script=({messages})=>toolResults(messages).length?{content:'I kept your email; tell me if you want a full redesign.'}:{calls:[{name:'compose_email',arguments:{subject:'New',blocks:[b('heading','New'),b('paragraph','Copy')]}}]};
  const {result,steps}=await turn(a,'Add a line about pricing','editor',editor('<p>My carefully written email about our spring product update, with three paragraphs of copy the team approved.</p>'));
  expect(steps.find(s=>s.name==='compose_email')?.status).toBe('failed');
  expect(result.operation).toBe('chat');
 },90000);

 it('saves memory from the AI agent page and keeps workspaces apart',async()=>{
  const a=await actor(),other=await actor();
  const put=await app.inject({method:'PUT',url:'/ai/memory',headers:headers(a),payload:{memory:{ind:'saas',about:'B2B intent data',voice:'Clear, confident',audience:'Revenue teams',rules:'No hype',learned:[['Website: https://valasys.com',1],['website: https://valasys.com',2]]}}});
  expect(put.statusCode,put.body).toBe(200);
  expect((await memory(a)).memory).toMatchObject({ind:'saas',voice:'Clear, confident',learned:[['Website: https://valasys.com',1]]});
  expect((await memory(other)).memory).toMatchObject({about:'',learned:[]});
  expect((await app.inject({method:'PUT',url:'/ai/memory',headers:headers(a),payload:{memory:{learned:Array.from({length:41},(_,i)=>[`Fact ${i}`,i])}}})).statusCode).toBe(400);
  expect((await app.inject({method:'PUT',url:'/ai/memory',headers:headers(a),payload:{nope:true}})).statusCode).toBe(400);
 },60000);
});
