/** One prompt to a launched campaign, on the real DeepSeek Harness runtime with a scripted model:
 * the AI plans an audience, emails and an A/B-tested journey; the user approves each part; launching
 * needs explicit confirmation, publishes the workflow and enrolls only sendable contacts.
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
async function actor(role='owner'){
 const email=`campaign-${randomUUID()}@example.test`,c=await db.insertInto('customers').values({email,name:'Northwind'}).returning('id').executeTakeFirstOrThrow(),u=await db.insertInto('users').values({email}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:role as any}).execute();
 const s=await createUserSession(u.id,{currentCustomerId:c.id}),a={cid:c.id,uid:u.id,token:s.token};actors.push(a);return a;
}
const headers=(a:any)=>({authorization:`Bearer ${a.token}`});
async function verifiedDomain(a:any){
 await withTenant(a.cid,trx=>trx.insertInto('sending_domains').values({customer_id:a.cid,domain:`nw-${a.cid.slice(0,8)}.example.test`,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true}).execute());
}
/** Three sendable inactive customers, one who unsubscribed and one without confirmed consent. */
async function contacts(a:any){
 const now=new Date();
 await withTenant(a.cid,trx=>trx.insertInto('audience_contacts').values([
  ...['priya','omar','lena'].map(n=>({customer_id:a.cid,email:`${n}@northwind.example.test`,name:n,status:'Subscribed' as const,consent_confirmed_at:now})),
  {customer_id:a.cid,email:'gone@northwind.example.test',name:'gone',status:'Unsubscribed' as const,consent_confirmed_at:now},
  {customer_id:a.cid,email:'pending@northwind.example.test',name:'pending',status:'Subscribed' as const,consent_confirmed_at:null},
 ]).execute());
}
async function turn(a:any,chat:string,instruction:string){
 const r=await app.inject({method:'POST',url:`/ai/chats/${chat}/turns`,headers:headers(a),payload:{request_id:randomUUID(),operation:'assist',instruction,settings:{mem:{voice:'Warm, direct, no hype'},timezone:'UTC'}}});
 expect(r.statusCode,r.body).toBe(202);
 await executeAiRun(a.cid,r.json().id,new AbortController().signal);
 const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',r.json().id).executeTakeFirstOrThrow());
 expect(run.status,String(run.error)).toBe('completed');
 const message=await withTenant(a.cid,trx=>trx.selectFrom('ai_chat_messages').select(['id']).where('run_id','=',run.id).where('role','=','assistant').executeTakeFirstOrThrow());
 return {run,result:run.result as any,messageId:message.id};
}
const decide=(a:any,chat:string,mid:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/ai/chats/${chat}/messages/${mid}/decision`,headers:headers(a),payload});

const block=(type:string,text:string,url?:string)=>({type,text,...(url?{url}:{})});
const WINBACK_CALLS=[
 {name:'define_audience',arguments:{name:'Inactive 30 days',rules:[{field:'Opened any email',op:'not in last',val:'30 days'},{field:'Clicked any email',op:'not in last',val:'30 days'}]}},
 {name:'draft_campaign_email',arguments:{key:'winback-1',name:'Win-back 1: we saved your spot',subject:'We saved your spot, {{first_name}}',preheader:'Everything that is new since you last logged in.',blocks:[block('heading','We saved your spot'),block('paragraph','It has been a while. Here is everything that is new since you last logged in.'),block('feature','Faster reports and a cleaner dashboard.'),block('button','See what is new','#')]}},
 {name:'draft_campaign_email',arguments:{key:'winback-2',name:'Win-back 2: still with us?',subject:'Still with us, {{first_name}}?',preheader:'One click to pick up where you left off.',blocks:[block('heading','Pick up where you left off'),block('paragraph','Your workspace is exactly as you left it.'),block('button','Open my workspace','#')]}},
 {name:'draft_campaign_email',arguments:{key:'winback-3',name:'Win-back 3: last note',subject:'Should we stop emailing you?',blocks:[block('heading','A last note from us'),block('paragraph','If now is not the right time, no problem.')]}},
 {name:'build_workflow',arguments:{name:'Win-back: inactive 30 days',trigger:'api',goal:'click',steps:[
  {t:'split',pct:50,paths:[{label:'A',steps:[{t:'email',template:'draft:winback-1'}]},{label:'B',steps:[{t:'email',template:'draft:winback-1',subject:'It has been a while, {{first_name}}'}]}]},
  {t:'wait',mode:'duration',amount:3,unit:'days'},{t:'email',template:'draft:winback-2'},
 ]}},
];

beforeAll(async()=>{
 llm=await startFakeAgentLlm(request=>script(request));
 for(const [k,v] of Object.entries({AI_ENABLED:'true',AI_ENABLED_TENANTS:'*',AI_BASE_URL:llm.baseUrl,AI_MODEL:'fixture-model'}))vi.stubEnv(k,v);
 setAgentRuntime(await createHarnessRuntime());
 await app.register(accountAiRoutes,{prefix:'/ai'});await app.ready();
},60000);
afterAll(async()=>{setAgentRuntime(undefined);vi.unstubAllEnvs();await app.close();await llm.close();for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}});

describe('Valasys AI campaign: one prompt to launch',()=>{
 it('plans audience, emails and an A/B journey, then saves, guards and launches it on approval',async()=>{
  const a=await actor(),chat=randomUUID();await verifiedDomain(a);await contacts(a);
  script=({messages,tools})=>{
   expect(tools.some(t=>t.endsWith('draft_campaign_email'))).toBe(true);
   const results=toolResults(messages);
   if(/Win back customers/.test(lastUserText(messages)))return results.length?{content:'I built a win-back campaign for 3 inactive customers: 3 emails, an A/B subject test on the first, a 3-day wait and a follow-up. Add links to the buttons, then review and approve; nothing sends until you launch.'}:{calls:WINBACK_CALLS};
   return {content:'ok'};
  };
  const {result,messageId}=await turn(a,chat,"Win back customers who've been inactive for 30 days.");
  expect(result.operation).toBe('campaign');
  expect(result.segment).toMatchObject({name:'Inactive 30 days',kind:'segment',matching:5,sendable:3});
  expect(result.emails.map((e:any)=>e.key)).toEqual(['winback-1','winback-2','winback-3']);
  expect(result.emails[0].html).toContain('{{unsubscribe_url}}');expect(result.emails[0].html).toContain('We saved your spot');
  const nodes=result.workflow.document.graph.nodes;
  expect(result.workflow.document.tkey).toBe('api');
  expect(nodes.filter((n:any)=>n.t==='email').map((n:any)=>n.template)).toEqual(['draft:winback-1','draft:winback-1','draft:winback-2']);
  expect(nodes.some((n:any)=>n.t==='split')).toBe(true);
  expect(result.workflow.issues).toEqual([]);
  expect(result.changes.join(' ')).toMatch(/3 can receive marketing email/);
  // The chat history shows the plan with no decisions yet.
  const history=(await app.inject({method:'GET',url:`/ai/chats/${chat}`,headers:headers(a)})).json();
  expect(history.messages.at(-1)).toMatchObject({plan_items:{}});

  // Guardrail: launching is never implicit.
  const unconfirmed=await decide(a,chat,messageId,{decision:'applied',item:'launch'});
  expect(unconfirmed.statusCode).toBe(400);expect(unconfirmed.json().error).toBe('launch_confirmation_required');
  expect((await decide(a,chat,messageId,{decision:'applied',item:'email:nope'})).statusCode).toBe(404);
  expect((await decide(a,chat,messageId,{decision:'applied',item:'../workflow'})).statusCode).toBe(400);

  // The user skips the third email and saves the audience; launching saves the rest and goes live.
  expect((await decide(a,chat,messageId,{decision:'skipped',item:'email:winback-3'})).json()).toMatchObject({decision:'skipped'});
  const audience=(await decide(a,chat,messageId,{decision:'applied',item:'audience'})).json();
  expect(audience).toMatchObject({decision:'applied'});
  const segment=await withTenant(a.cid,trx=>trx.selectFrom('audience_collections').selectAll().where('id','=',audience.id).executeTakeFirstOrThrow());
  expect(segment).toMatchObject({kind:'segment',name:'Inactive 30 days'});
  const launched=await decide(a,chat,messageId,{decision:'applied',item:'launch',confirm:true,timezone:'Europe/Berlin'});
  expect(launched.statusCode,launched.body).toBe(200);
  expect(launched.json()).toMatchObject({decision:'applied',enrolled:3,not_started:0});
  const items=launched.json().plan_items;
  expect(Object.keys(items).sort()).toEqual(['audience','email:winback-1','email:winback-2','email:winback-3','launch','workflow']);
  const workflow=await withTenant(a.cid,trx=>trx.selectFrom('workflows').selectAll().where('id','=',items.workflow.id).executeTakeFirstOrThrow());
  expect(workflow.status).toBe('active');
  const savedTemplates=(workflow.builder_document as any).graph.nodes.filter((n:any)=>n.t==='email').map((n:any)=>n.template);
  expect(savedTemplates).toEqual([items['email:winback-1'].id,items['email:winback-1'].id,items['email:winback-2'].id]);
  const templates=await withTenant(a.cid,trx=>trx.selectFrom('templates').select(['name','subject']).where('customer_id','=',a.cid).orderBy('name').execute());
  expect(templates.map(t=>t.name)).toEqual(['Win-back 1: we saved your spot','Win-back 2: still with us?']);
  const runs=await withTenant(a.cid,trx=>trx.selectFrom('workflow_runs').select('subject_email').where('workflow_id','=',workflow.id).orderBy('subject_email').execute());
  expect(runs.map(r=>r.subject_email)).toEqual(['lena@northwind.example.test','omar@northwind.example.test','priya@northwind.example.test']);
  // Approving again (double click, retry) never enrolls twice.
  const again=await decide(a,chat,messageId,{decision:'applied',item:'launch',confirm:true});
  expect(again.json()).toMatchObject({decision:'applied',enrolled:3});
  expect(await withTenant(a.cid,trx=>trx.selectFrom('workflow_runs').select('id').where('workflow_id','=',workflow.id).execute())).toHaveLength(3);
 },120000);

 it('edits the same campaign in a follow-up and keeps parts the user did not mention',async()=>{
  const a=await actor(),chat=randomUUID();await verifiedDomain(a);await contacts(a);
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),prompt=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
   if(/Win back customers/.test(ask))return results.length?{content:'Built the win-back campaign.'}:{calls:WINBACK_CALLS};
   if(/second email shorter/.test(ask)){
    if(results.length)return {content:'Shortened the second email and moved the follow-up to 5 days after the first email.'};
    expect(prompt).toContain('Current campaign');expect(prompt).toContain('draft:winback-2');
    const wait=prompt.match(/(n[0-9a-f]{8}): wait 3 days/)![1]!;
    return {calls:[{name:'draft_campaign_email',arguments:{key:'winback-2',subject:'Still with us?',blocks:[block('heading','Pick up where you left off'),block('button','Open my workspace','#')]}},{name:'update_step',arguments:{id:wait,fields:{amount:5}}}]};
   }
   return {content:'ok'};
  };
  await turn(a,chat,"Win back customers who've been inactive for 30 days.");
  const {result}=await turn(a,chat,'Make the second email shorter and wait 5 days before it.');
  expect(result.operation).toBe('campaign');
  expect(result.emails.map((e:any)=>[e.key,e.subject])).toEqual([['winback-1','We saved your spot, {{first_name}}'],['winback-2','Still with us?'],['winback-3','Should we stop emailing you?']]);
  expect(result.emails[1].blocks).toHaveLength(2);
  expect(result.segment.name).toBe('Inactive 30 days');
  const waits=result.workflow.document.graph.nodes.filter((n:any)=>n.t==='wait');
  expect(waits.map((n:any)=>n.amount)).toEqual([5]);
 },120000);

 it('refuses links the user did not give and blocks launch until a sending domain is verified',async()=>{
  const a=await actor(),chat=randomUUID();await contacts(a);let attempts=0;
  script=({messages})=>{
   const results=toolResults(messages);
   if(!results.length)return {calls:[{name:'define_audience',arguments:{name:'Everyone recent',rules:[{field:'created',operator:'in_last',value:'30d'}]}},{name:'draft_campaign_email',arguments:{key:'promo',subject:'Our spring update',blocks:[block('heading','Spring update'),block('button','Shop now','https://evil.example.test/track')]}}]};
   if(results.some(r=>/was not provided by the user/.test(r)) && attempts++===0)return {calls:[{name:'draft_campaign_email',arguments:{key:'promo',subject:'Our spring update',blocks:[block('heading','Spring update'),block('button','Shop now','#')]}},{name:'build_workflow',arguments:{name:'Spring update',trigger:'api',steps:[{t:'email',template:'draft:promo'}]}}]};
   return {content:'Drafted the spring update for recent contacts. Add the shop link and verify a sending domain before launching.'};
  };
  const {result,messageId}=await turn(a,chat,'Send a spring update to contacts who joined in the last 30 days.');
  expect(result.operation).toBe('campaign');
  expect(result.segment.rules).toEqual([{field:'Created',op:'in last',val:'30 days'}]);
  expect(result.emails[0].html).not.toContain('evil.example.test');
  expect(result.workflow.issues.join(' ')).toMatch(/sending domain/i);
  const blocked=await decide(a,chat,messageId,{decision:'applied',item:'launch',confirm:true});
  expect(blocked.statusCode).toBe(422);expect(blocked.json().message).toMatch(/^Nothing was sent/);
  expect(await withTenant(a.cid,trx=>trx.selectFrom('workflow_runs').select('id').where('customer_id','=',a.cid).execute())).toHaveLength(0);
  // Drafts stay saved so the user can fix the domain and launch again.
  const state=(await app.inject({method:'GET',url:`/ai/chats/${chat}`,headers:headers(a)})).json().messages.at(-1).plan_items;
  expect(state.workflow.decision).toBe('applied');expect(state.launch).toBeUndefined();
  const flow=await withTenant(a.cid,trx=>trx.selectFrom('workflows').select('status').where('id','=',state.workflow.id).executeTakeFirstOrThrow());
  expect(flow.status).not.toBe('active');
 },120000);

 it('never launches twice from one conversation, only launches the latest version, and requires a one-time trigger',async()=>{
  const a=await actor(),chat=randomUUID();await verifiedDomain(a);await contacts(a);
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),prompt=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
   if(/Win back customers/.test(ask))return results.length?{content:'Built it.'}:{calls:WINBACK_CALLS};
   if(/subject of the second email/.test(ask))return results.length?{content:'Changed it.'}:{calls:[{name:'draft_campaign_email',arguments:{key:'winback-2',subject:'Still there?'}}]};
   if(/start it when someone opens/.test(ask))return results.length?{content:'Changed the trigger.'}:{calls:[{name:'set_trigger',arguments:{trigger:'opened'}}]};
   if(/relaunch/.test(ask)){expect(prompt).toContain('already launched its campaign');return {content:'This campaign is already live; I can draft a new version, but it cannot be launched again from this chat.'};}
   return {content:'ok'};
  };
  const v1=await turn(a,chat,"Win back customers who've been inactive for 30 days.");
  const v2=await turn(a,chat,'Change the subject of the second email.');
  // The older version cannot launch while a newer one exists.
  const stale=await decide(a,chat,v1.messageId,{decision:'applied',item:'launch',confirm:true});
  expect(stale.statusCode).toBe(409);expect(stale.json().message).toMatch(/newer version/);
  // Reject all, then change of mind: a skipped launch (and skipped audience) can still be approved.
  for(const item of ['audience','launch'])expect((await decide(a,chat,v2.messageId,{decision:'skipped',item})).json().decision).toBe('skipped');
  const launched=await decide(a,chat,v2.messageId,{decision:'applied',item:'launch',confirm:true});
  expect(launched.statusCode,launched.body).toBe(200);expect(launched.json()).toMatchObject({decision:'applied',enrolled:3});
  expect(launched.json().plan_items.audience.decision).toBe('applied');
  // A follow-up version in the same conversation can be saved but never enrolls the audience again.
  const v3=await turn(a,chat,'Now relaunch it with a new subject.');
  expect(v3.result.operation).toBe('chat');
  const v4=await turn(a,chat,'Change the subject of the second email again.');
  const again=await decide(a,chat,v4.messageId,{decision:'applied',item:'launch',confirm:true});
  expect(again.statusCode).toBe(409);expect(again.json().message).toMatch(/already launched/);
  expect(await withTenant(a.cid,trx=>trx.selectFrom('workflow_runs').select('id').where('customer_id','=',a.cid).execute())).toHaveLength(3);
  // A plan whose journey has an ongoing trigger is refused before anything is published.
  const b=await actor(),other=randomUUID();await verifiedDomain(b);await contacts(b);
  await turn(b,other,"Win back customers who've been inactive for 30 days.");
  const evented=await turn(b,other,'Actually start it when someone opens an email.');
  const blocked=await decide(b,other,evented.messageId,{decision:'applied',item:'launch',confirm:true});
  expect(blocked.statusCode).toBe(422);expect(blocked.json().message).toMatch(/Started via API or manually/);
  expect(await withTenant(b.cid,trx=>trx.selectFrom('workflows').select('status').where('customer_id','=',b.cid).where('status','=','active').execute())).toHaveLength(0);
 },180000);

 it('keeps campaign tools out of the editors and launch out of reach of read-only roles',async()=>{
  const a=await actor(),chat=randomUUID();let seen:string[]=[];
  script=({tools,messages})=>{seen=tools;return toolResults(messages).length?{content:'Done.'}:{content:'Here is how the workflow works.'};};
  const r=await app.inject({method:'POST',url:`/ai/chats/${chat}/turns`,headers:headers(a),payload:{request_id:randomUUID(),operation:'workflow',instruction:'Explain this workflow',settings:{workflow:{}}}});
  expect(r.statusCode,r.body).toBe(202);await executeAiRun(a.cid,r.json().id,new AbortController().signal);
  expect(seen.some(t=>t.endsWith('add_steps'))).toBe(true);expect(seen.some(t=>/campaign|define_audience/.test(t))).toBe(false);
  const other=await actor();
  expect((await decide(other,chat,randomUUID(),{decision:'applied',item:'launch',confirm:true})).statusCode).toBe(404);
 },120000);
});
