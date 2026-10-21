import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import Fastify,{type FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {db,createUserSession,withTenant,executeAiRun,maintainAiRuns,aiQueue,enqueueAiRun} from '@platform/shared';

let app:FastifyInstance;
let rlsPool:pg.Pool;
type Actor={cid:string;uid:string;sid:string;token:string};
const actors:Actor[]=[];
async function actor(){
  const email=`ai-${randomUUID()}@example.test`;
  const c=await db.insertInto('customers').values({email,name:'AI synthetic fixture'}).returning('id').executeTakeFirstOrThrow();
  const u=await db.insertInto('users').values({email,name:'AI synthetic fixture'}).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:'owner'}).execute();
  const s=await createUserSession(u.id,{currentCustomerId:c.id});
  const result={cid:c.id,uid:u.id,sid:s.session_id,token:s.token};actors.push(result);return result;
}
function headers(a:Actor){return {authorization:`Bearer ${a.token}`};}
function request(){return {request_id:randomUUID(),input:{operation:'subjects',content:'Synthetic dashboard update',instruction:'',subject:'',tone:'Friendly'}};}
async function create(a:Actor,body=request()){
  const response=await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:body});
  expect(response.statusCode,response.body).toBe(202);return response.json();
}
beforeAll(async()=>{
  vi.stubEnv('AI_ENABLED','true');vi.stubEnv('AI_ENABLED_TENANTS','*');vi.stubEnv('AI_BASE_URL','https://inference.fixture.test');vi.stubEnv('AI_MODEL','fixture-model');
  app=Fastify();await app.register(accountAiRoutes,{prefix:'/v1/account/ai'});await app.ready();
  rlsPool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  await rlsPool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_rls_test') THEN CREATE ROLE ai_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
  await rlsPool.query('GRANT USAGE ON SCHEMA public TO ai_rls_test; GRANT SELECT ON ai_runs TO ai_rls_test');
});
afterAll(async()=>{
  vi.unstubAllGlobals();vi.unstubAllEnvs();await app.close();
  for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}
  await rlsPool.end();
});

describe('customer AI durable writing runs',()=>{
  it('requires human authentication and strict input',async()=>{
    expect((await app.inject({method:'GET',url:'/v1/account/ai/capabilities'})).statusCode).toBe(401);
    const a=await actor();expect((await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:{...request(),model:'bad'}})).statusCode).toBe(400);
    for(const operation of ['route','compact'])expect((await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:{...request(),input:{...request().input,operation}}})).statusCode).toBe(400);
  });
  it('deduplicates the same request, rejects changed payload, limits active runs and isolates owners',async()=>{
    const a=await actor(),b=await actor(),body=request(),run=await create(a,body);
    expect((await create(a,body)).id).toBe(run.id);
    expect((await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:{...body,input:{...body.input,content:'different'}}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:request()})).statusCode).toBe(409);
    for(const method of ['GET','POST'] as const){expect((await app.inject({method,url:`/v1/account/ai/runs/${run.id}${method==='POST'?'/cancel':''}`,headers:headers(b)})).statusCode).toBe(404);}
    // RLS protects the database even when an application-level tenant predicate is absent.
    const client=await rlsPool.connect();
    try{
      await client.query('BEGIN');await client.query('SET LOCAL ROLE ai_rls_test');
      await client.query("select set_config('app.customer_id',$1,true)",[b.cid]);
      expect((await client.query('SELECT id FROM ai_runs WHERE id=$1',[run.id])).rows).toEqual([]);
      await client.query('ROLLBACK');
    }finally{client.release();}
    const u=await db.insertInto('users').values({email:`ai-colleague-${randomUUID()}@example.test`}).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('memberships').values({customer_id:a.cid,user_id:u.id,role:'owner'}).execute();
    const s=await createUserSession(u.id,{currentCustomerId:a.cid});actors.push({cid:a.cid,uid:u.id,sid:s.session_id,token:s.token});
    expect((await app.inject({method:'GET',url:`/v1/account/ai/runs/${run.id}`,headers:{authorization:`Bearer ${s.token}`}})).statusCode).toBe(404);
  });
  it('completes validated output once, hides provider metadata and does not run cancelled requests',async()=>{
    const a=await actor(),run=await create(a),fetcher=vi.fn(async()=>new Response(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify({subjects:['Dashboard improvements','See the latest changes','Your new workspace view']})},prompt_eval_count:100,eval_count:50})));
    vi.stubGlobal('fetch',fetcher);
    await executeAiRun(a.cid,run.id,new AbortController().signal);
    await executeAiRun(a.cid,run.id,new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const status=await app.inject({method:'GET',url:`/v1/account/ai/runs/${run.id}`,headers:headers(a)});
    expect(status.json()).toMatchObject({status:'completed',result:{operation:'subjects'}});
    expect(Array.isArray(status.json().warnings)).toBe(true);
    expect(status.body).not.toContain('fixture-model');expect(status.body).not.toContain('session_id');
    const cancelled=await create(a);
    expect((await app.inject({method:'POST',url:`/v1/account/ai/runs/${cancelled.id}/cancel`,headers:headers(a)})).json().status).toBe('cancelled');
    await executeAiRun(a.cid,cancelled.id,new AbortController().signal);expect(fetcher).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('recovers lost dispatch intent and fences output after a concurrent cancellation',async()=>{
    const a=await actor(),run=await create(a);
    expect(await maintainAiRuns(a.cid)).toContain(run.id);
    await enqueueAiRun(a.cid,run.id);expect((await aiQueue.getJob(run.id))?.data.run_id).toBe(run.id);
    let finish!:(response:Response)=>void,started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    vi.stubGlobal('fetch',async()=>{started();return new Promise<Response>(resolve=>{finish=resolve;});});
    const executing=executeAiRun(a.cid,run.id,new AbortController().signal);await ready;
    await app.inject({method:'POST',url:`/v1/account/ai/runs/${run.id}/cancel`,headers:headers(a)});
    finish(new Response(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify({subjects:['One','Two','Three']})}})));
    await executing;
    expect((await app.inject({method:'GET',url:`/v1/account/ai/runs/${run.id}`,headers:headers(a)})).json()).toMatchObject({status:'cancelled',result:null});
    vi.unstubAllGlobals();
  });
  it('does not infer after session revocation or role downgrade',async()=>{
    const a=await actor(),run=await create(a),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await db.updateTable('user_sessions').set({revoked_at:new Date()}).where('id','=',a.sid).execute();
    await executeAiRun(a.cid,run.id,new AbortController().signal);expect(fetcher).not.toHaveBeenCalled();
    const b=await actor(),other=await create(b);
    await db.updateTable('memberships').set({role:'analyst'}).where('customer_id','=',b.cid).where('user_id','=',b.uid).execute();
    await executeAiRun(b.cid,other.id,new AbortController().signal);expect(fetcher).not.toHaveBeenCalled();
    expect((await app.inject({method:'GET',url:`/v1/account/ai/runs/${other.id}`,headers:headers(b)})).statusCode).toBe(403);
    vi.unstubAllGlobals();
  });
  it('expires queued work and refuses disabled tenants without running inference',async()=>{
    const a=await actor(),run=await create(a);
    await withTenant(a.cid,trx=>trx.updateTable('ai_runs').set({deadline:new Date(Date.now()-1000)}).where('id','=',run.id).execute());
    expect(await maintainAiRuns(a.cid)).not.toContain(run.id);
    expect((await app.inject({method:'GET',url:`/v1/account/ai/runs/${run.id}`,headers:headers(a)})).json().status).toBe('timed_out');
    vi.stubEnv('AI_ENABLED_TENANTS','');
    expect((await app.inject({method:'POST',url:'/v1/account/ai/generations',headers:headers(a),payload:request()})).statusCode).toBe(403);
    vi.stubEnv('AI_ENABLED_TENANTS','*');
  });
});
