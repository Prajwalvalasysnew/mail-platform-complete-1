import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {db,createUserSession,executeAiRun,withTenant,maintainAiRuns} from '@platform/shared';
const app=Fastify(),actors:{cid:string;uid:string;token:string;sid:string}[]=[];
async function actor(){const email=`chat-${randomUUID()}@example.test`,c=await db.insertInto('customers').values({email,name:'Chat fixture'}).returning('id').executeTakeFirstOrThrow(),u=await db.insertInto('users').values({email}).returning('id').executeTakeFirstOrThrow();await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:'owner'}).execute();const session=await createUserSession(u.id,{currentCustomerId:c.id}),a={cid:c.id,uid:u.id,token:session.token,sid:session.session_id};actors.push(a);return a;}
const headers=(a:any)=>({authorization:`Bearer ${a.token}`});
async function turn(a:any,id:string,instruction:string,extra={}){const r=await app.inject({method:'POST',url:`/ai/chats/${id}/turns`,headers:headers(a),payload:{request_id:randomUUID(),operation:'chat',instruction,settings:{},...extra}});expect(r.statusCode,r.body).toBe(202);return r.json();}
async function chat(a:any,id:string){const r=await app.inject({method:'GET',url:`/ai/chats/${id}`,headers:headers(a)});expect(r.statusCode,r.body).toBe(200);return r.json();}
const reply=(output:unknown)=>new Response(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify(output)},prompt_eval_count:100,eval_count:50}));
function model(text='Acknowledged.'){return vi.fn(async(_url:unknown,options:any)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);return reply(input.operation==='route'?{calls:[]}:input.operation==='compact'?{summary:'The project codename is ORCHID-731. Preserve the requested plain tone.'}:input.operation==='draft'?{subject:'Project update',preheader:'Progress overview',blocks:[{type:'paragraph',text:'The dashboard is available.',url:''}]}:{text});});}
beforeAll(async()=>{vi.stubEnv('AI_ENABLED','true');vi.stubEnv('AI_ENABLED_TENANTS','*');vi.stubEnv('AI_BASE_URL','https://fixture.test');vi.stubEnv('AI_MODEL','fixture-model');
 // Compaction fixtures are sized for an 8k-token route.
 vi.stubEnv('AI_CONTEXT_TOKENS','8192');vi.stubEnv('AI_MAX_OUTPUT_TOKENS','3000');await app.register(accountAiRoutes,{prefix:'/ai'});await app.ready();});
afterEach(()=>vi.unstubAllGlobals());
afterAll(async()=>{vi.unstubAllEnvs();await app.close();for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}});
describe('durable AI chat and harness-style checkpoints',()=>{
 it('keeps builder chats out of the main chat list even after later settings change',async()=>{
  const a=await actor(),flow=randomUUID(),editor=randomUUID(),main=randomUUID();
  const submit=async(id:string,extra:any)=>{const run=await turn(a,id,'Scoped conversation',extra);expect((await app.inject({method:'POST',url:`/ai/runs/${run.id}/cancel`,headers:headers(a)})).statusCode).toBe(200);};
  await submit(flow,{operation:'workflow',settings:{workflow:{id:randomUUID()}}});
  await submit(editor,{operation:'editor',settings:{editor:{key:randomUUID(),content:'',subject:'',tone:'Professional'}}});
  await submit(main,{});
  await submit(flow,{operation:'chat',settings:{}});
  const scoped=await app.inject({method:'GET',url:'/ai/chats?scope=agent',headers:headers(a)});
  expect(scoped.statusCode).toBe(200);expect(scoped.json().chats.map((c:any)=>c.id)).toEqual([main]);
  const all=await app.inject({method:'GET',url:'/ai/chats',headers:headers(a)});expect(all.json().chats).toHaveLength(3);
  expect((await chat(a,flow)).chat.surface).toBe('workflow');expect((await chat(a,editor)).chat.surface).toBe('editor');
  const b=await actor();expect((await app.inject({method:'GET',url:'/ai/chats?scope=agent',headers:headers(b)})).json().chats).toEqual([]);
 });
 it('restores history across authenticated sessions, deduplicates turns, and isolates owners',async()=>{
  const a=await actor(),b=await actor(),id=randomUUID(),request_id=randomUUID(),fetcher=model();vi.stubGlobal('fetch',fetcher);
  const first=await turn(a,id,'Remember ORCHID-731',{request_id});await executeAiRun(a.cid,first.id,new AbortController().signal);
  expect((await turn(a,id,'Remember ORCHID-731',{request_id})).id).toBe(first.id);
  const second=await turn(a,id,'What is the codename?');await executeAiRun(a.cid,second.id,new AbortController().signal);
  const input=JSON.parse(JSON.parse((fetcher.mock.calls.at(-1) as any)[1].body).messages[1].content);
  expect(JSON.parse(input.content).conversation).toEqual([{role:'user',content:'Remember ORCHID-731'},{role:'assistant',content:'Acknowledged.'}]);
  const session=await createUserSession(a.uid,{currentCustomerId:a.cid});await db.updateTable('user_sessions').set({revoked_at:new Date()}).where('id','=',a.sid).execute();
  expect((await chat({...a,token:session.token},id)).messages).toHaveLength(4);
  expect((await app.inject({method:'GET',url:`/ai/chats/${id}`,headers:headers(b)})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`/ai/chats/${id}/turns`,headers:headers(b),payload:{request_id:randomUUID(),operation:'chat',instruction:'Steal',settings:{}}})).statusCode).not.toBe(202);
 });
 it('keeps each chat context to its own messages, even for other chats and members of the same workspace',async()=>{
  const a=await actor(),fetcher=model();vi.stubGlobal('fetch',fetcher);
  const teammate=await db.insertInto('users').values({email:`chat-${randomUUID()}@example.test`}).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('memberships').values({customer_id:a.cid,user_id:teammate.id,role:'owner'}).execute();
  const session=await createUserSession(teammate.id,{currentCustomerId:a.cid}),b={cid:a.cid,uid:teammate.id,token:session.token,sid:session.id};
  const other=randomUUID(),own=randomUUID();
  const secret=await turn(b,other,'Teammate secret PLUM-404');await executeAiRun(b.cid,secret.id,new AbortController().signal);
  const sibling=await turn(a,randomUUID(),'Other chat note KIWI-12');await executeAiRun(a.cid,sibling.id,new AbortController().signal);
  const first=await turn(a,own,'Remember ORCHID-731');await executeAiRun(a.cid,first.id,new AbortController().signal);
  const next=await turn(a,own,'What is the codename?');await executeAiRun(a.cid,next.id,new AbortController().signal);
  const sent=JSON.stringify(fetcher.mock.calls.at(-1));
  expect(sent).toContain('ORCHID-731');expect(sent).not.toContain('PLUM-404');expect(sent).not.toContain('KIWI-12');
  await db.deleteFrom('users').where('id','=',teammate.id).execute();
 });
 it('keeps failed requests in context and extends chat expiry on every message',async()=>{
  const a=await actor(),id=randomUUID();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})));
  const failed=await turn(a,id,'Draft the ORCHID-731 announcement');await executeAiRun(a.cid,failed.id,new AbortController().signal);
  expect((await chat(a,id)).messages.at(-1).status).toBe('failed');
  await withTenant(a.cid,trx=>trx.updateTable('ai_chats').set({expires_at:new Date(Date.now()+60000)}).where('id','=',id).execute());
  const fetcher=model();vi.stubGlobal('fetch',fetcher);
  const retry=await turn(a,id,'Try again');await executeAiRun(a.cid,retry.id,new AbortController().signal);
  const conversation=JSON.parse(JSON.parse(JSON.parse((fetcher.mock.calls.at(-1) as any)[1].body).messages[1].content).content).conversation;
  expect(conversation[0].content).toBe('Draft the ORCHID-731 announcement');expect(conversation[1].content).toMatch(/failed or was stopped/);
  const saved=await chat(a,id);expect(new Date(saved.chat.expires_at).getTime()).toBeGreaterThan(Date.now()+29*86400000);
 });
 it('does not reset the daily limit when conversations are deleted',async()=>{
  vi.stubEnv('AI_USER_DAILY_LIMIT','2');
  try{
   const a=await actor();vi.stubGlobal('fetch',model());
   for(let n=0;n<2;n++){const id=randomUUID(),r=await turn(a,id,`Request ${n}`);await executeAiRun(a.cid,r.id,new AbortController().signal);expect((await app.inject({method:'DELETE',url:`/ai/chats/${id}`,headers:headers(a)})).statusCode).toBe(200);}
   const blocked=await app.inject({method:'POST',url:`/ai/chats/${randomUUID()}/turns`,headers:headers(a),payload:{request_id:randomUUID(),operation:'chat',instruction:'One more',settings:{}}});
   expect(blocked.statusCode).toBe(429);expect(blocked.json().message).toMatch(/More become available at/);
  }finally{vi.stubEnv('AI_USER_DAILY_LIMIT','50');}
 });
 it('automatically checkpoints older balanced turns without deleting the transcript or losing the prior checkpoint',async()=>{
  const a=await actor(),id=randomUUID(),fetcher=model('Status detail '.repeat(190));vi.stubGlobal('fetch',fetcher);
  for(let n=0;n<5;n++){const r=await turn(a,id,n===0?'Remember ORCHID-731. Keep a plain tone.':`Continue update ${n}`);await executeAiRun(a.cid,r.id,new AbortController().signal);}
  const saved=await chat(a,id);expect(saved.messages).toHaveLength(10);expect(saved.checkpoints.length).toBeGreaterThan(0);
  expect(saved.messages[0].text).toContain('ORCHID-731');
  const calls=fetcher.mock.calls.map(([,o]:any)=>JSON.parse(JSON.parse(o.body).messages[1].content));
  expect(calls.some(x=>x.operation==='compact')).toBe(true);
  expect(JSON.parse(calls.at(-1).content).checkpoint).toContain('ORCHID-731');
  expect(saved.messages.every((m:any)=>m.status==='completed')).toBe(true);
 });
 it('compacts an oversized plain-text response in bounded pieces without truncating stored history',async()=>{
  const a=await actor(),id=randomUUID();vi.stubGlobal('fetch',model('x'.repeat(11000)));const first=await turn(a,id,'Remember ORCHID-731');await executeAiRun(a.cid,first.id,new AbortController().signal);
  vi.stubGlobal('fetch',model());const next=await turn(a,id,'Continue');await executeAiRun(a.cid,next.id,new AbortController().signal);
  const saved=await chat(a,id);expect(saved.messages[1].text).toHaveLength(11000);expect(saved.messages.at(-1).status).toBe('completed');expect(saved.checkpoints).toHaveLength(1);
 });
 it('supports explicit compaction and preserves history when summarization fails',async()=>{
  const a=await actor(),id=randomUUID();vi.stubGlobal('fetch',model());const first=await turn(a,id,'Remember ORCHID-731');await executeAiRun(a.cid,first.id,new AbortController().signal);
  vi.stubGlobal('fetch',vi.fn(async()=>reply({wrong:'invalid'})));const bad=await turn(a,id,'/compact');await executeAiRun(a.cid,bad.id,new AbortController().signal);
  let saved=await chat(a,id);expect(saved.checkpoints).toHaveLength(0);expect(saved.messages[0].text).toContain('ORCHID-731');expect(saved.messages.at(-1).status).toBe('failed');
  vi.stubGlobal('fetch',model());const good=await turn(a,id,'/compact');await executeAiRun(a.cid,good.id,new AbortController().signal);
  saved=await chat(a,id);expect(saved.checkpoints).toHaveLength(1);expect(saved.messages.at(-1).text).toContain('full chat history is preserved');expect(saved.messages).toHaveLength(6);
 });
 it('compacts and retries once after a confirmed provider context overflow',async()=>{
  const a=await actor(),id=randomUUID();vi.stubGlobal('fetch',model());const first=await turn(a,id,'Remember ORCHID-731');await executeAiRun(a.cid,first.id,new AbortController().signal);
  const normal=model();let overflow=true;const fetcher=vi.fn(async(url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content);if(input.operation==='chat' && overflow){overflow=false;return new Response(JSON.stringify({error:'context window exceeded'}),{status:400});}return normal(url,o);});vi.stubGlobal('fetch',fetcher);
  const next=await turn(a,id,'Recall the codename');await executeAiRun(a.cid,next.id,new AbortController().signal);
  const saved=await chat(a,id);expect(saved.messages.at(-1).status).toBe('completed');expect(saved.checkpoints).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(4);
 });
 it('fences checkpoint publication when compaction is cancelled',async()=>{
  const a=await actor(),id=randomUUID();vi.stubGlobal('fetch',model());const first=await turn(a,id,'Remember ORCHID-731');await executeAiRun(a.cid,first.id,new AbortController().signal);
  let finish!:(r:Response)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});vi.stubGlobal('fetch',async()=>{started();return new Promise<Response>(r=>{finish=r;});});
  const next=await turn(a,id,'/compact'),executing=executeAiRun(a.cid,next.id,new AbortController().signal);await ready;
  await app.inject({method:'POST',url:`/ai/runs/${next.id}/cancel`,headers:headers(a)});finish(reply({summary:'ORCHID-731 remains the project name.'}));await executing;
  const saved=await chat(a,id);expect(saved.checkpoints).toHaveLength(0);expect(saved.messages.at(-1).status).toBe('cancelled');
 });
 it('commits an approved draft once even when approval is repeated concurrently',async()=>{
  const a=await actor(),id=randomUUID();vi.stubGlobal('fetch',model());const r=await turn(a,id,'Write an email announcement',{operation:'draft'});await executeAiRun(a.cid,r.id,new AbortController().signal);
  const mid=(await chat(a,id)).messages.at(-1).id;
  const decide=()=>app.inject({method:'POST',url:`/ai/chats/${id}/messages/${mid}/decision`,headers:headers(a),payload:{decision:'applied'}});
  const [one,two]=await Promise.all([decide(),decide()]);expect(one.statusCode,one.body).toBe(200);expect(two.json().template_id).toBe(one.json().template_id);
  expect((await withTenant(a.cid,trx=>trx.selectFrom('templates').select('id').where('customer_id','=',a.cid).execute()))).toHaveLength(1);
  expect((await chat(a,id)).messages.at(-1).decision).toBe('applied');
 });
 it('preserves quota records and reports interrupted work after login-session deletion',async()=>{
  const a=await actor(),id=randomUUID(),r=await turn(a,id,'Remember ORCHID-731');
  await db.deleteFrom('user_sessions').where('id','=',a.sid).execute();
  const session=await createUserSession(a.uid,{currentCustomerId:a.cid});
  const saved=await chat({...a,token:session.token},id);expect(saved.messages.at(-1).status).toBe('failed');
  expect(await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').select('id').where('id','=',r.id).executeTakeFirst())).toBeDefined();
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await executeAiRun(a.cid,r.id,new AbortController().signal);expect(fetcher).not.toHaveBeenCalled();
 });
 it('recovers an interrupted worker once and excludes failed replies from future context',async()=>{
  const a=await actor(),id=randomUUID(),shutdown=new AbortController();let finish!:(r:Response)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  vi.stubGlobal('fetch',async()=>{started();return new Promise<Response>(r=>{finish=r;});});
  const r=await turn(a,id,'Remember ORCHID-731'),running=executeAiRun(a.cid,r.id,shutdown.signal);await ready;shutdown.abort();finish(reply({text:'This stale answer must not be saved.'}));await running;
  expect((await chat(a,id)).messages.at(-1).status).toBe('queued');
  const fetcher=model();vi.stubGlobal('fetch',fetcher);await executeAiRun(a.cid,r.id,new AbortController().signal);
  const saved=await chat(a,id);expect(saved.messages.at(-1).status).toBe('completed');expect(saved.messages.at(-1).text).toBe('Acknowledged.');
 });
 it('pages older messages and enforces database tenant isolation for all conversation tables',async()=>{
  const a=await actor(),b=await actor(),id=randomUUID();const r=await turn(a,id,'Start history');
  await app.inject({method:'POST',url:`/ai/runs/${r.id}/cancel`,headers:headers(a)});
  await withTenant(a.cid,async trx=>{const values=Array.from({length:210},(_,i)=>({id:randomUUID(),customer_id:a.cid,chat_id:id,run_id:null,seq:i+3,role:(i%2?'assistant':'user') as 'user'|'assistant',text:`History item ${i}`,status:'completed',result:i%2?{operation:'chat',text:`History item ${i}`}:{context_settings:{}},error:null,template_id:null,decision:null}));await trx.insertInto('ai_chat_messages').values(values).execute();});
  const newest=await chat(a,id);expect(newest.messages).toHaveLength(200);expect(newest.has_more).toBe(true);expect(newest.messages.at(-1).seq).toBe(212);
  const older=await app.inject({method:'GET',url:`/ai/chats/${id}?before_seq=${newest.before_seq}`,headers:headers(a)});expect(older.json().messages).toHaveLength(12);expect(older.json().has_more).toBe(false);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),client=await pool.connect();
  try{
   await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_chat_rls_test') THEN CREATE ROLE ai_chat_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
   await client.query('GRANT USAGE ON SCHEMA public TO ai_chat_rls_test; GRANT SELECT ON ai_chats,ai_chat_messages,ai_chat_checkpoints,ai_run_steps TO ai_chat_rls_test');await client.query('BEGIN');await client.query('SET LOCAL ROLE ai_chat_rls_test');await client.query("select set_config('app.customer_id',$1,true)",[b.cid]);
   for(const table of ['ai_chats','ai_chat_messages','ai_chat_checkpoints','ai_run_steps'])expect((await client.query(`SELECT customer_id FROM ${table} WHERE customer_id=$1`,[a.cid])).rows).toEqual([]);
   await client.query('ROLLBACK');
  }finally{client.release();await pool.end();}
 });
 it('retains expired conversations under a legal hold and purges after release',async()=>{
  const a=await actor(),id=randomUUID();await turn(a,id,'Held conversation');
  const hold=await withTenant(a.cid,trx=>trx.insertInto('legal_holds').values({customer_id:a.cid,scope:'all',reason:'Synthetic hold',created_by:null,released_at:null,released_by:null}).returning('id').executeTakeFirstOrThrow());
  await withTenant(a.cid,trx=>trx.updateTable('ai_chats').set({expires_at:new Date(Date.now()-1000)}).where('id','=',id).execute());await maintainAiRuns(a.cid);
  expect(await withTenant(a.cid,trx=>trx.selectFrom('ai_chats').select('id').where('id','=',id).executeTakeFirst())).toBeDefined();
  await withTenant(a.cid,trx=>trx.updateTable('legal_holds').set({released_at:new Date()}).where('id','=',hold.id).execute());await maintainAiRuns(a.cid);
  // Its reply is still queued, so the chat is kept until that run settles.
  expect(await withTenant(a.cid,trx=>trx.selectFrom('ai_chats').select('id').where('id','=',id).executeTakeFirst())).toBeDefined();
  await withTenant(a.cid,trx=>trx.updateTable('ai_runs').set({status:'failed',input:null}).where('chat_id','=',id).execute());await maintainAiRuns(a.cid);
  expect(await withTenant(a.cid,trx=>trx.selectFrom('ai_chats').select('id').where('id','=',id).executeTakeFirst())).toBeUndefined();
 });
 it('grounds delivery answers in actual tenant rollups and persists read observations',async()=>{
  const a=await actor(),id=randomUUID(),day=new Date().toISOString().slice(0,10);
  await withTenant(a.cid,trx=>trx.insertInto('usage_daily').values({customer_id:a.cid,usage_date:day,sent:100,delivered:92,bounced:3,complained:1}).execute());
  const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content),context=JSON.parse(input.content),evidence=context.workspace_observations || [];
   if(input.operation==='route')return reply({calls:evidence.length?[]:[{tool:'delivery_summary',id:null,query:'',days:7}]});
   const data=evidence[0].data;return reply({text:`Delivered: ${data.delivered}; Bounced: ${data.bounced}; source: ${data.source}`});});vi.stubGlobal('fetch',fetcher);
  const r=await turn(a,id,'What are my workspace delivery totals?');await executeAiRun(a.cid,r.id,new AbortController().signal);
  const saved=await chat(a,id);expect(saved.messages.at(-1).text).toContain('Delivered: 92; Bounced: 3');expect(saved.steps.some((x:any)=>x.name==='delivery_summary' && x.status==='completed')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(3);
  const trace=await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select('observation').where('run_id','=',r.id).where('name','=','delivery_summary').executeTakeFirstOrThrow());expect((trace.observation as any).data.delivered).toBe(92);
 });
 it('uses the selected real template and denies a cross-tenant template ID',async()=>{
  const a=await actor(),b=await actor(),own=await withTenant(a.cid,trx=>trx.insertInto('templates').values({customer_id:a.cid,name:'Reference',subject:'CEDAR-482',text_body:'Approved source copy',html_body:null}).returning('id').executeTakeFirstOrThrow()),foreign=await withTenant(b.cid,trx=>trx.insertInto('templates').values({customer_id:b.cid,name:'Private',subject:'PRIVATE_FOREIGN_SUBJECT',text_body:'private',html_body:null}).returning('id').executeTakeFirstOrThrow());
  const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content),c=JSON.parse(input.content);return reply(input.operation==='route'?{calls:[]}:{text:c.workspace_observations[0].data.subject || 'Selected template unavailable.'});});vi.stubGlobal('fetch',fetcher);
  const id=randomUUID(),r=await turn(a,id,'Explain the selected source',{settings:{context:[{kind:'template',id:own.id,label:'Reference'}]}});await executeAiRun(a.cid,r.id,new AbortController().signal);expect((await chat(a,id)).messages.at(-1).text).toBe('CEDAR-482');
  const other=randomUUID(),bad=await turn(a,other,'Explain the selected source',{settings:{context:[{kind:'template',id:foreign.id,label:'Private'}]}});await executeAiRun(a.cid,bad.id,new AbortController().signal);expect((await chat(a,other)).messages.at(-1).text).toContain('unavailable');expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE_FOREIGN_SUBJECT');
 });
 it('retrieves exact earlier messages only from the current owner retained history',async()=>{
  const a=await actor(),b=await actor();vi.stubGlobal('fetch',model());const ownId=randomUUID(),otherId=randomUUID(),one=await turn(a,ownId,'Use the exact label CEDAR-482.'),two=await turn(b,otherId,'PRIVATE_FOREIGN_HISTORY');await executeAiRun(a.cid,one.id,new AbortController().signal);await executeAiRun(b.cid,two.id,new AbortController().signal);
  const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content),c=JSON.parse(input.content),found=c.workspace_observations || [];return reply(input.operation==='route'?{calls:found.length?[]:[{tool:'search_history',id:null,query:'CEDAR-482',days:7}]}:{text:found[0].data[0].text});});vi.stubGlobal('fetch',fetcher);
  const id=randomUUID(),r=await turn(a,id,'Find my earlier exact message about the label.');await executeAiRun(a.cid,r.id,new AbortController().signal);expect((await chat(a,id)).messages.at(-1).text).toBe('Use the exact label CEDAR-482.');expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE_FOREIGN_HISTORY');
 });
 it('blocks repeat reads and rejects unregistered model-proposed tools',async()=>{
  const a=await actor(),id=randomUUID();const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content);return reply(input.operation==='route'?{calls:[{tool:'workspace_overview',id:null,query:'',days:7}]}:{text:'Workspace reviewed.'});});vi.stubGlobal('fetch',fetcher);
  const r=await turn(a,id,'Read my workspace.');await executeAiRun(a.cid,r.id,new AbortController().signal);const saved=await chat(a,id);expect(saved.steps.filter((x:any)=>x.name==='workspace_overview' && x.status==='completed')).toHaveLength(1);expect(saved.steps.some((x:any)=>x.status==='blocked')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(3);
  vi.stubGlobal('fetch',async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content);return reply(input.operation==='route'?{calls:[{tool:'execute_sql',id:null,query:'DELETE FROM templates',days:7}]}:{text:'No authorized evidence was available.'});});
  const bad=await turn(a,randomUUID(),'Read my workspace.');await executeAiRun(a.cid,bad.id,new AbortController().signal);const records=await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select('name').where('run_id','=',bad.id).execute());expect(records.some(x=>x.name==='execute_sql')).toBe(false);
 });
 it('never includes domain private keys or verification tokens in model evidence',async()=>{
  const a=await actor(),id=randomUUID();await withTenant(a.cid,trx=>trx.insertInto('sending_domains').values({customer_id:a.cid,domain:'synthetic.example.test',dkim_selector:'s1',dkim_public_key:'public',dkim_private_key:'PRIVATE_KEY_MUST_NOT_LEAK',verification_token:'TOKEN_MUST_NOT_LEAK'}).execute());
  const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content),c=JSON.parse(input.content);return reply(input.operation==='route'?{calls:(c.workspace_observations || []).length?[]:[{tool:'domain_status',id:null,query:'',days:7}]}:{text:'The domain has not been verified.'});});vi.stubGlobal('fetch',fetcher);
  const r=await turn(a,id,'Check my sending domain verification.');await executeAiRun(a.cid,r.id,new AbortController().signal);expect((await chat(a,id)).messages.at(-1).status).toBe('completed');expect((await chat(a,id)).steps.some((s:any)=>s.name==='domain_status' && s.status==='completed')).toBe(true);expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE_KEY_MUST_NOT_LEAK');expect(JSON.stringify(fetcher.mock.calls)).not.toContain('TOKEN_MUST_NOT_LEAK');
 });
 it('fails fast when the provider is unavailable during planning and preserves the saved transcript',async()=>{
  const a=await actor(),id=randomUUID(),fetcher=vi.fn(async()=>{throw new TypeError('Synthetic connection failure');});vi.stubGlobal('fetch',fetcher);
  const r=await turn(a,id,'Read my workspace.');await executeAiRun(a.cid,r.id,new AbortController().signal);
  const saved=await chat(a,id);expect(saved.messages).toHaveLength(2);expect(saved.messages.at(-1).status).toBe('failed');expect(saved.messages.at(-1).error).toContain('temporarily unavailable');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('answers the exact connected-domain question and a tool-dependent follow-up without keyword gating',async()=>{
  const a=await actor(),b=await actor(),id=randomUUID();
  for(const [who,count] of [[a,23],[b,2]] as const)await withTenant(who.cid,trx=>trx.insertInto('sending_domains').values(Array.from({length:count},(_,n)=>({customer_id:who.cid,domain:`domain-${n}-${who.cid}.example.test`,dkim_selector:'s1',dkim_public_key:'public',dkim_private_key:'secret',verification_token:randomUUID()}))).execute());
  const fetcher=vi.fn(async(_url:unknown,o:any)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content),ctx=JSON.parse(input.content),found=ctx.workspace_observations || [];
    if(input.operation==='route')return reply({calls:found.length?[]:[{tool:'domain_status',id:null,query:'',days:7}]});
    expect(found[0].data.connected).toBe(23);expect(found[0].data.domains).toHaveLength(20);expect(found[0].data.truncated).toBe(true);
    return reply({text:`You have ${found[0].data.connected} connected domains; ${found[0].data.verified} are verified.`});});vi.stubGlobal('fetch',fetcher);
  for(const prompt of ["how many domain's I have connected?",'and how many are verified?']){const r=await turn(a,id,prompt);await executeAiRun(a.cid,r.id,new AbortController().signal);expect((await chat(a,id)).messages.at(-1).text).toContain('23 connected domains; 0 are verified');}
 });
 it('deletes conversations and their runs and expires retained chat content',async()=>{
  const a=await actor(),id=randomUUID(),r=await turn(a,id,'Remember this');
  expect((await app.inject({method:'DELETE',url:`/ai/runs/${r.id}`,headers:headers(a)})).json().error).toBe('delete_conversation');
  expect((await app.inject({method:'DELETE',url:`/ai/chats/${id}`,headers:headers(a)})).statusCode).toBe(200);
  // The run stays as a quota marker (deleting must not reset the daily limit) but its content is erased and it is stopped.
  const marker=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').select(['chat_id','input','result','status','expires_at']).where('id','=',r.id).executeTakeFirstOrThrow());
  expect(marker).toMatchObject({chat_id:null,input:null,result:null,status:'cancelled'});expect(marker.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
  expect((await app.inject({method:'GET',url:`/ai/runs/${r.id}`,headers:headers(a)})).statusCode).toBe(404);
  const expired=randomUUID();await turn(a,expired,'Expire this');await withTenant(a.cid,trx=>trx.updateTable('ai_chats').set({expires_at:new Date(Date.now()-1000)}).where('id','=',expired).execute());
  expect((await app.inject({method:'GET',url:`/ai/chats/${expired}`,headers:headers(a)})).statusCode).toBe(404);
  await withTenant(a.cid,trx=>trx.updateTable('ai_runs').set({status:'failed',input:null}).where('chat_id','=',expired).execute());await maintainAiRuns(a.cid);
  expect(await withTenant(a.cid,trx=>trx.selectFrom('ai_chats').select('id').where('id','=',expired).executeTakeFirst())).toBeUndefined();
 });
});
