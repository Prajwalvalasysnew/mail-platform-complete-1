/** Editor/assistant turns run on the real DeepSeek Harness runtime with a scripted model.
 * Replays the conversation that exposed the old structured-draft approach: attractive template,
 * CTA button, orange background, user-supplied link, and edits that must not rebuild the email.
 */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {db,createUserSession,executeAiRun,withTenant,setAgentRuntime} from '@platform/shared';
import {createHarnessRuntime} from '@platform/worker/ai-harness.js';
import {startFakeAgentLlm,latestDocument,lastUserText,toolResults,type FakeScript} from '../fixtures/fake-agent-llm.js';

const app=Fastify(),actors:{cid:string;uid:string;token:string}[]=[];
let llm:Awaited<ReturnType<typeof startFakeAgentLlm>>,script:FakeScript=()=>({content:'ok'});
async function actor(){const email=`agent-${randomUUID()}@example.test`,c=await db.insertInto('customers').values({email,name:'Agent fixture'}).returning('id').executeTakeFirstOrThrow(),u=await db.insertInto('users').values({email}).returning('id').executeTakeFirstOrThrow();await db.insertInto('memberships').values({customer_id:c.id,user_id:u.id,role:'owner'}).execute();const s=await createUserSession(u.id,{currentCustomerId:c.id}),a={cid:c.id,uid:u.id,token:s.token};actors.push(a);return a;}
const PLACEHOLDER='<div class="email" style="max-width:600px;margin:24px auto;background:#fff;min-height:400px;border-radius:12px;padding:32px"><p style="font-family:Arial,sans-serif;color:#444">Add your email content here.</p></div>';
async function editorTurn(a:any,chatId:string,instruction:string,canvas:{html:string;subject?:string;preheader?:string},extra:Record<string,unknown>={}){
 const r=await app.inject({method:'POST',url:`/ai/chats/${chatId}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation:'editor',instruction,settings:{editor:{key:chatId,content:'',subject:canvas.subject || '',preheader:canvas.preheader || '',html:canvas.html,tone:'Professional',...extra}}}});
 expect(r.statusCode,r.body).toBe(202);
 await executeAiRun(a.cid,r.json().id,new AbortController().signal);
 const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',r.json().id).executeTakeFirstOrThrow());
 expect(run.status,String(run.error)).toBe('completed');
 return {run,result:run.result as any,steps:await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select(['name','status','observation']).where('run_id','=',run.id).orderBy('seq').execute())};
}
const idOf=(doc:string,pattern:RegExp)=>{const m=doc.match(pattern);if(!m)throw new Error(`No element matching ${pattern} in ${doc.slice(0,400)}`);return m[1]!;};

const DESIGN=`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2ff"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px">
<tr><td style="padding:48px;background-color:#1e1b4b;color:#ffffff"><h1 style="margin:0;font-size:34px">Meet VAIS by Valasys AI</h1><p style="margin:12px 0 0">Intent intelligence that tells your team who is ready to buy.</p></td></tr>
<tr><td style="padding:32px 48px"><h2 style="margin:0 0 8px">Why teams choose VAIS</h2><p style="margin:0">Prioritise accounts, personalise outreach and focus on pipeline that converts.</p></td></tr>
<tr><td style="padding:24px 48px;font-size:12px;color:#6b7280"><a href="{{unsubscribe_url}}" style="color:#6b7280">Unsubscribe</a></td></tr>
</table></td></tr></table>`;

beforeAll(async()=>{
 llm=await startFakeAgentLlm(request=>script(request));
 for(const [k,v] of Object.entries({AI_ENABLED:'true',AI_ENABLED_TENANTS:'*',AI_BASE_URL:llm.baseUrl,AI_MODEL:'fixture-model'}))vi.stubEnv(k,v);
 setAgentRuntime(await createHarnessRuntime());
 await app.register(accountAiRoutes,{prefix:'/ai'});await app.ready();
},60000);
afterAll(async()=>{setAgentRuntime(undefined);vi.unstubAllEnvs();await app.close();await llm.close();for(const a of actors){await db.deleteFrom('customers').where('id','=',a.cid).execute();await db.deleteFrom('users').where('id','=',a.uid).execute();}});

describe('email agent on the DeepSeek Harness runtime',()=>{
 it('ends a repeated invalid workflow-tool loop with a clear saved answer',async()=>{
  const a=await actor(),id=randomUUID();let attempt=0;
  script=()=>({calls:[{name:'add_steps',arguments:{after:'trigger',steps:[{t:'sms',attempt:++attempt}]}}]});
  const accepted=await app.inject({method:'POST',url:`/ai/chats/${id}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation:'workflow',instruction:'Build an unsupported message flow',settings:{workflow:{}}}});
  expect(accepted.statusCode,accepted.body).toBe(202);
  await executeAiRun(a.cid,accepted.json().id,new AbortController().signal);
  const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',accepted.json().id).executeTakeFirstOrThrow());
  expect(run.status,String(run.error)).toBe('completed');expect((run.result as any).operation).toBe('chat');
  expect((run.result as any).text).toMatch(/could not finish.*repeatedly rejected/);
  const calls=await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select('status').where('run_id','=',run.id).where('name','=','add_steps').execute());
  expect(calls).toHaveLength(4);expect(calls.every(c=>c.status==='failed')).toBe(true);
 },60000);
 it('creates a designed template, then adds a CTA and orange background without rebuilding it, then links the CTA',async()=>{
  const a=await actor(),chat=randomUUID();
  script=({messages,text})=>{
   const ask=lastUserText(messages),results=toolResults(messages);
   if(/attractive email template/.test(ask)){
    if(!results.length)return {calls:[{name:'write_email',arguments:{html:DESIGN}},{name:'set_subject',arguments:{subject:'Meet VAIS: intent data that converts',preheader:'See which accounts are ready to buy.'}}]};
    return {content:'I created a premium VAIS launch email with a hero, benefits and footer.'};
   }
   if(/add good cta/.test(ask)){
    if(!results.length){const doc=latestDocument(messages);
     return {calls:[
      {name:'update_element',arguments:{id:idOf(doc,/<table[^>]*data-ai="(e\d+)"[^>]*>/),styles:{'background-color':'#f97316'}}},
      {name:'insert_html',arguments:{id:idOf(doc,/<p[^>]*data-ai="(e\d+)"[^>]*>Prioritise/),position:'after',html:'<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f97316" style="border-radius:8px"><a href="https://invented.example/demo" style="display:inline-block;padding:14px 32px;color:#ffffff">Book your demo</a></td></tr></table>'}},
     ]};}
    if(results.length===2 && results.some(r=>/was not provided by the user/.test(r))){
     const doc=latestDocument(messages);
     return {calls:[{name:'insert_html',arguments:{id:idOf(doc,/<p[^>]*data-ai="(e\d+)"[^>]*>Prioritise/),position:'after',html:'<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f97316" style="border-radius:8px"><a href="#" style="display:inline-block;padding:14px 32px;color:#ffffff">Book your demo</a></td></tr></table>'}}]};
    }
    return {content:'I added a "Book your demo" button and made the background orange. Share the link for the button.'};
   }
   if(/valasys\.com\/product/.test(ask)){
    if(!results.length){const doc=latestDocument(messages);return {calls:[{name:'update_element',arguments:{id:idOf(doc,/<a href="#"[^>]*data-ai="(e\d+)"/),attributes:{href:'https://valasys.com/product'}}}]};}
    return {content:'The CTA button now links to https://valasys.com/product.'};
   }
   return {content:`unexpected: ${text(messages.at(-1)!)}`};
  };
  const first=await editorTurn(a,chat,'I want you to create highly attractive email template in html for valasys ai product vais',{html:PLACEHOLDER});
  console.log(JSON.stringify(first.result),JSON.stringify(first.steps),JSON.stringify(llm.requests.map(r=>({tools:r.tools,msgs:r.messages.map(m=>[m.role,String(typeof m.content==='string'?m.content:JSON.stringify(m.content)).slice(-300)])}))).slice(0,4000));
  expect(first.result.operation).toBe('draft');
  expect(first.result.html).toContain('Meet VAIS by Valasys AI');expect(first.result.html).not.toContain('data-ai');
  expect(first.result.subject).toBe('Meet VAIS: intent data that converts');expect(first.result.changes.join(' ')).toMatch(/Created the email design/);
  expect(first.steps.map(s=>s.name)).toEqual(['write_email','set_subject']);

  const second=await editorTurn(a,chat,'add good cta and also change the temlate\'s bg to orange',{html:first.result.html,subject:first.result.subject,preheader:first.result.preheader});
  const html=second.result.html as string;
  expect(html).toContain('background-color:#f97316');
  expect(html).toMatch(/<a href="#"[^>]*>Book your demo<\/a>/);expect(html).not.toContain('invented.example');
  // Targeted edits: the existing copy and structure stay exactly as they were.
  for(const kept of ['Meet VAIS by Valasys AI','Why teams choose VAIS','Prioritise accounts','{{unsubscribe_url}}'])expect(html).toContain(kept);
  expect(second.steps.map(s=>`${s.name}:${s.status}`)).toEqual(['update_element:completed','insert_html:failed','insert_html:completed']);
  expect(JSON.stringify(second.steps[1]!.observation)).toContain('was not provided by the user');
  expect(second.result.message).toContain('Book your demo');

  const third=await editorTurn(a,chat,'use this one "https://valasys.com/product"',{html,subject:second.result.subject});
  expect(third.result.html).toMatch(/<a href="https:\/\/valasys\.com\/product"[^>]*>Book your demo<\/a>/);
  expect(third.result.html.replace(/https:\/\/valasys\.com\/product/,'#')).toBe(html);
  expect(third.result.changes).toEqual(['Updated link “Book your demo”: href: https://valasys.com/product']);
  // The harness saw the conversation so far, including the earlier change summaries.
  const prompt=llm.requests.at(-2)!.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
  expect(prompt).toContain('Changes made:');expect(prompt).toContain('Book your demo');
 },120000);

 it('verifies claimed edits, accepts bare domains the user typed, and answers questions without editing',async()=>{
  const a=await actor(),chat=randomUUID();
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),doc=latestDocument(messages);
   if(/^Verification:/m.test(ask))return results.length?{content:'The heading is now 44px.'}:{calls:[{name:'update_element',arguments:{id:idOf(doc,/<h1[^>]*data-ai="(e\d+)"/),styles:{'font-size':'44px'}}}]};
   if(/heading bigger/.test(ask))return {content:"I've made the heading bigger."};
   if(/link the heading/.test(ask))return results.length?{content:'Linked.'}:{calls:[{name:'insert_html',arguments:{id:idOf(doc,/<h1[^>]*data-ai="(e\d+)"/),position:'after',html:'<p><a href="https://valasys.com">Visit valasys.com</a></p>'}}]};
   if(/subject line/.test(ask))return {content:'Try “See who is ready to buy with VAIS”.'};
   return {content:'unexpected'};
  };
  const bigger=await editorTurn(a,chat,'make the heading bigger',{html:DESIGN});
  expect(bigger.result.html).toContain('font-size:44px');expect(bigger.result.message).toBe('The heading is now 44px.');
  const linked=await editorTurn(a,chat,'link the heading area to valasys.com',{html:DESIGN});
  expect(linked.result.html).toContain('href="https://valasys.com"');
  const question=await editorTurn(a,chat,'what is a good subject line for this?',{html:DESIGN});
  expect(question.result).toEqual({operation:'chat',text:'Try “See who is ready to buy with VAIS”.'});
 },120000);

 it('lets the main assistant draft a template and keeps revising that draft',async()=>{
  const a=await actor(),chat=randomUUID();
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),doc=latestDocument(messages);
   if(/welcome email/.test(ask))return results.length?{content:'Drafted a welcome email.'}:{calls:[{name:'write_email',arguments:{html:DESIGN,subject:'Welcome to VAIS'}}]};
   if(/heading blue/.test(ask))return results.length?{content:'Heading is blue now.'}:{calls:[{name:'update_element',arguments:{id:idOf(doc,/<h1[^>]*data-ai="(e\d+)"/),styles:{color:'#2563eb'}}}]};
   return {content:'unexpected'};
  };
  const turn=async(instruction:string)=>{const r=await app.inject({method:'POST',url:`/ai/chats/${chat}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation:'assist',instruction,settings:{}}});expect(r.statusCode,r.body).toBe(202);await executeAiRun(a.cid,r.json().id,new AbortController().signal);};
  await turn('Write a welcome email for new VAIS users');await turn('Make the heading blue');
  const saved=(await app.inject({method:'GET',url:`/ai/chats/${chat}`,headers:{authorization:`Bearer ${a.token}`}})).json();
  const drafts=saved.messages.filter((m:any)=>m.result?.operation==='draft');
  expect(drafts).toHaveLength(2);expect(drafts[1].result.html).toContain('color:#2563eb');expect(drafts[1].result.subject).toBe('Welcome to VAIS');
  const approved=await app.inject({method:'POST',url:`/ai/chats/${chat}/messages/${drafts[1].id}/decision`,headers:{authorization:`Bearer ${a.token}`},payload:{decision:'applied'}});
  expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().template_id).toBeTruthy();
 },120000);
 it('builds and edits workflows in the workflow builder and drafts workflows from any page',async()=>{
  const a=await actor(),chat=randomUUID();
  const template=await withTenant(a.cid,trx=>trx.insertInto('templates').values({customer_id:a.cid,name:'Win-back offer',subject:'We miss you',html_body:'<p>Hi</p>',text_body:'Hi'}).returning('id').executeTakeFirstOrThrow());
  await withTenant(a.cid,trx=>trx.insertInto('sending_domains').values({customer_id:a.cid,domain:`acme-${a.cid.slice(0,8)}.example.test`,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true}).execute());
  script=({messages})=>{
   const ask=lastUserText(messages),results=toolResults(messages),prompt=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
   const templateId=prompt.match(/^([0-9a-f-]{36}): Win-back offer/m)?.[1];
   if(/win-back journey/.test(ask))return results.length?{content:'I built a win-back workflow: on click, wait 2 days, then send “Win-back offer”.'}:{calls:[{name:'build_workflow',arguments:{name:'Win-back journey',trigger:'clicked',steps:[{t:'wait',mode:'duration',amount:2,unit:'days'},{t:'email',template:templateId}]}}]};
   if(/wait 3 days and add an SMS/.test(ask)){
    if(!results.length){const wait=prompt.match(/→ (n[0-9a-f]{8}): wait 2 days/)![1]!,email=prompt.match(/→ (n[0-9a-f]{8}): send email/)![1]!;return {calls:[{name:'update_step',arguments:{id:wait,fields:{amount:3}}},{name:'add_steps',arguments:{after:email,steps:[{t:'sms',text:'Come back'}]}}]};}
    return {content:'The wait is now 3 days. SMS steps are not supported yet, so I did not add one.'};
   }
   if(/welcome workflow/.test(ask))return results.length?{content:'Drafted a welcome workflow for you to review.'}:{calls:[{name:'build_workflow',arguments:{name:'Welcome',trigger:'event',steps:[{t:'email',template:templateId},{t:'wait',mode:'event',event:'opened',max:3},{t:'branch',cond:'activated',paths:[{label:'Yes',steps:[]},{label:'No',steps:[{t:'email',template:templateId}]}]}]}}]};
   return {content:'unexpected'};
  };
  const blank={name:'Untitled workflow 1',tkey:'event',settings:{reentry:'once',goal:'none',audience:'all',quiet:false,cap:false},graph:{nodes:[{id:'trigger',t:'trigger',x:0,y:0}],edges:[]}};
  const flowTurn=async(instruction:string,document:unknown)=>{const r=await app.inject({method:'POST',url:`/ai/chats/${chat}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation:'workflow',instruction,settings:{workflow:{document}}}});expect(r.statusCode,r.body).toBe(202);await executeAiRun(a.cid,r.json().id,new AbortController().signal);const run=await withTenant(a.cid,trx=>trx.selectFrom('ai_runs').selectAll().where('id','=',r.json().id).executeTakeFirstOrThrow());expect(run.status,String(run.error)).toBe('completed');return {result:run.result as any,steps:await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select(['name','status']).where('run_id','=',run.id).orderBy('seq').execute())};};
  const built=await flowTurn('Set up a win-back journey for people who click',blank);
  expect(built.result.operation).toBe('workflow');expect(built.result.document.tkey).toBe('clicked');expect(built.result.issues).toEqual([]);
  const nodes=built.result.document.graph.nodes;expect(nodes.map((n:any)=>n.t)).toEqual(['trigger','wait','email']);expect(nodes[2].template).toBe(template.id);
  const edited=await flowTurn('make the wait 3 days and add an SMS after the email',built.result.document);
  expect(edited.steps.map(s=>`${s.name}:${s.status}`)).toEqual(['update_step:completed','add_steps:failed']);
  expect(edited.result.document.graph.nodes.find((n:any)=>n.t==='wait').amount).toBe(3);expect(edited.result.document.graph.nodes).toHaveLength(3);
  expect(edited.result.message).toContain('not supported');
  expect(JSON.stringify(await withTenant(a.cid,trx=>trx.selectFrom('ai_run_steps').select('observation').where('name','=','add_steps').execute()))).toContain('SMS is not available');
  // The browser never stores canvas state with chat history.
  const stored=await withTenant(a.cid,trx=>trx.selectFrom('ai_chat_messages').select('result').where('chat_id','=',chat).where('role','=','user').execute());
  expect(JSON.stringify(stored)).not.toContain('"graph"');

  const assistChat=randomUUID();
  const r=await app.inject({method:'POST',url:`/ai/chats/${assistChat}/turns`,headers:{authorization:`Bearer ${a.token}`},payload:{request_id:randomUUID(),operation:'assist',instruction:'Build a welcome workflow for new signups',settings:{page:{view:'automations'}}}});
  expect(r.statusCode,r.body).toBe(202);await executeAiRun(a.cid,r.json().id,new AbortController().signal);
  expect(llm.requests.at(-2)!.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n')).toContain('opened on Automations (workflows)');
  const saved=(await app.inject({method:'GET',url:`/ai/chats/${assistChat}`,headers:{authorization:`Bearer ${a.token}`}})).json(),draft=saved.messages.at(-1);
  expect(draft.result.operation).toBe('workflow');expect(draft.result.issues).toEqual([]);
  const approved=await app.inject({method:'POST',url:`/ai/chats/${assistChat}/messages/${draft.id}/decision`,headers:{authorization:`Bearer ${a.token}`},payload:{decision:'applied'}});
  expect(approved.statusCode,approved.body).toBe(200);
  const workflow=await withTenant(a.cid,trx=>trx.selectFrom('workflows').select(['name','status','builder_document']).where('id','=',approved.json().workflow_id).executeTakeFirstOrThrow());
  expect(workflow.status).toBe('draft');expect((workflow.builder_document as any).graph.nodes.map((n:any)=>n.t)).toEqual(['trigger','email','wait','branch','email']);
 },120000);
});
