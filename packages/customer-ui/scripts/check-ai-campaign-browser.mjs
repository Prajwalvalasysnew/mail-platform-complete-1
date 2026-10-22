// Production-bundle browser acceptance for the advertised Valasys AI flow: one prompt plans a
// win-back campaign (segment, emails, A/B-tested journey), the user approves its parts in the chat,
// and launching asks for confirmation, publishes the workflow and enrolls the sendable contacts.
// Runs the real API server, AI worker and DeepSeek Harness against a scripted model.
// Build shared/api/worker/customer-ui first, then from the repo root:
//   node --env-file=.env.test [--env-file=.env.test.local] packages/customer-ui/scripts/check-ai-campaign-browser.mjs
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import shared from '@platform/shared';
const {db,createUserSession,closeDb,closeRedis,closeQueues}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL).pathname))throw new Error('Browser verification requires the isolated mail_test database');
const out='packages/customer-ui/test-results/ai-campaign';await mkdir(out,{recursive:true});
const prefix=`ai_browser_campaign_${Date.now()}_`;

const text=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map(p=>p.text || '').join(''):'';
const ask=messages=>{for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]);if(messages[i].role!=='user')continue;if(/^Verification:/.test(t))return t;const at=t.lastIndexOf('User request:\n');if(at>=0)return t.slice(at+14);}return '';};
const results=messages=>{const r=[];for(let i=messages.length-1;i>=0 && messages[i].role==='tool';i--)r.unshift(text(messages[i]));return r;};
const b=(type,text,url)=>({type,text,...(url?{url}:{})});
function model(messages){
 const q=ask(messages),done=results(messages);
 if(/Win back customers/i.test(q))return done.length?{content:'I planned a win-back campaign for 3 inactive customers: 2 emails with an A/B subject test on the first, a 3-day wait and a follow-up. Review and approve it; nothing sends until you launch.'}:{calls:[
  ['define_audience',{name:'Inactive 30 days',rules:[{field:'Opened any email',op:'not in last',val:'30 days'},{field:'Clicked any email',op:'not in last',val:'30 days'}]}],
  ['draft_campaign_email',{key:'winback-1',name:'Win-back 1: we saved your spot',subject:'We saved your spot, {{first_name}}',preheader:'Everything that is new since you last logged in.',blocks:[b('heading','We saved your spot'),b('paragraph','It has been a while. Here is everything that is new since you last logged in.'),b('button','See what is new','#')]}],
  ['draft_campaign_email',{key:'winback-2',name:'Win-back 2: still with us?',subject:'Still with us, {{first_name}}?',blocks:[b('heading','Pick up where you left off'),b('paragraph','Your workspace is exactly as you left it.')]}],
  ['build_workflow',{name:'Win-back: inactive 30 days',trigger:'api',goal:'click',steps:[{t:'split',pct:50,paths:[{label:'A',steps:[{t:'email',template:'draft:winback-1'}]},{label:'B',steps:[{t:'email',template:'draft:winback-1',subject:'It has been a while, {{first_name}}'}]}]},{t:'wait',mode:'duration',amount:3,unit:'days'},{t:'email',template:'draft:winback-2'}]}],
 ]};
 return {content:'I can help with that.'};
}
let callNo=0;
const llm=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),tools=(body.tools||[]).map(t=>t.function.name),turn=model(body.messages||[]);
 const calls=(turn.calls||[]).map(([name,args])=>({id:`c${++callNo}`,type:'function',function:{name:tools.find(t=>t.endsWith(`__${name}`))||name,arguments:JSON.stringify(args)}}));
 // The first "slow summary" request hangs so the browser can press Stop; later ones answer immediately.
 const hold=false;
 setTimeout(()=>{if(res.destroyed)return;
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:calls.length?{role:'assistant',tool_calls:calls.map((c,index)=>({index,...c}))}:{role:'assistant',content:turn.content},finish_reason:null}]})}\n\n`);
 res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\n`);
 res.end('data: [DONE]\n\n');},hold?60000:0);});});
await new Promise(r=>llm.listen(3102,'127.0.0.1',r));

const email=`ai-campaign-${randomUUID()}@example.test`;
let customer,user,api,worker,browser,failed=false,logs='';const ui=Fastify();
try{
 customer=await db.insertInto('customers').values({email,name:'Synthetic AI campaign check',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Synthetic AI campaign check'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 await db.insertInto('sending_domains').values({customer_id:customer.id,domain:`nw-${customer.id.slice(0,8)}.example.test`,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true}).execute();
 await db.insertInto('audience_contacts').values([...['priya','omar','lena'].map(n=>({customer_id:customer.id,email:`${n}@northwind.example.test`,name:n,status:'Subscribed',consent_confirmed_at:new Date()})),{customer_id:customer.id,email:'gone@northwind.example.test',name:'gone',status:'Unsubscribed',consent_confirmed_at:new Date()}]).execute();
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const env={...process.env,QUEUE_PREFIX:prefix,API_PORT:'3011',AI_ENABLED:'true',AI_BASE_URL:'http://127.0.0.1:3102',AI_MODEL:'fixture-model',AI_ALLOW_PRIVATE_HTTP:'true',AI_ENABLED_TENANTS:customer.id,AI_HEALTH_PORT:'19105'};
 const keep=d=>{logs=(logs+d).slice(-6000);};
 api=spawn(process.execPath,['packages/api/dist/bootstrap.js'],{env,stdio:['ignore','pipe','pipe']});api.stdout.on('data',keep);api.stderr.on('data',keep);
 worker=spawn(process.execPath,['packages/worker/dist/ai-worker.js'],{env,stdio:['ignore','pipe','pipe']});worker.stdout.on('data',keep);worker.stderr.on('data',keep);
 for(let i=0;;i++){try{if((await fetch('http://127.0.0.1:3011/health')).ok)break;}catch{}if(i>60)throw new Error(`API did not start\n${logs}`);await new Promise(r=>setTimeout(r,500));}
 ui.removeAllContentTypeParsers();ui.addContentTypeParser('*',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 ui.all('/api/*',async(req,reply)=>{const r=await fetch(`http://127.0.0.1:3011/v1${req.url.slice(4)}`,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k))),body:['GET','HEAD'].includes(req.method)?undefined:req.body});reply.code(r.status);for(const [k,v] of r.headers)if(!['content-encoding','transfer-encoding','connection'].includes(k))reply.header(k,v);return reply.send(Buffer.from(await r.arrayBuffer()));});
 ui.get('/assets/:file',async(req,reply)=>{const file=req.params.file;if(!/^[\w.-]+$/.test(file))return reply.code(404).send();const type={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';return reply.type(type).send(await readFile(path.join('packages/customer-ui/dist/assets',file)));});
 ui.get('/*',async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
 await ui.listen({port:3101,host:'127.0.0.1'});
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);

 // 1. One prompt plans the whole campaign.
 await page.goto('http://127.0.0.1:3101/ai-agent');
 const composer=page.getByPlaceholder(/Ask anything/);await composer.waitFor();
 await composer.fill("Win back customers who've been inactive for 30 days.");await composer.press('Enter');
 await page.getByText('I planned a win-back campaign').waitFor({timeout:90000});
 for(const text of ['Campaign plan','Inactive 30 days','5 waiting for approval','Win-back 1: we saved your spot','Win-back 2: still with us?','Win-back: inactive 30 days','Email 3 contacts'])await page.getByText(text,{exact:false}).first().waitFor();
 await page.getByText('A/B test “Win-back 1: we saved your spot”: “We saved your spot, {{first_name}}” vs “It has been a while, {{first_name}}” → wait 3 days → send “Win-back 2: still with us?”').waitFor();
 await page.getByText('4 contacts match, 3 can receive marketing email',{exact:false}).waitFor();
 console.log('Browser: one prompt planned audience, emails and an A/B journey with live counts');
 await page.screenshot({path:`${out}/1-campaign-plan.png`,fullPage:true});

 // 2. Approving the segment saves it; declining the launch dialog sends nothing.
 const approve=()=>page.getByRole('button',{name:'Approve',exact:true});
 await approve().first().click();
 await page.getByText('Segment saved.').waitFor();
 const segment=await db.selectFrom('audience_collections').select(['kind','name']).where('customer_id','=',customer.id).executeTakeFirstOrThrow();
 if(segment.kind!=='segment' || segment.name!=='Inactive 30 days')throw new Error(`Saved audience: ${JSON.stringify(segment)}`);
 let dialogs=0;page.once('dialog',d=>{dialogs++;if(!/Launch this campaign now\?/.test(d.message()))throw new Error(d.message());void d.dismiss();});
 await approve().last().click();
 await page.waitForTimeout(800);
 if(dialogs!==1)throw new Error('Launch did not ask for confirmation');
 if((await db.selectFrom('workflow_runs').select('id').where('customer_id','=',customer.id).execute()).length)throw new Error('A dismissed launch enrolled contacts');
 console.log('Browser: segment saved; dismissing the launch confirmation sends nothing');

 // 3. Confirming the launch saves the remaining parts, publishes and enrolls the sendable contacts.
 page.once('dialog',d=>void d.accept());
 await approve().last().click();
 await page.getByText('Campaign launched: 3 contacts enrolled.').waitFor({timeout:30000});
 await page.getByText('Live · 3 contacts enrolled').waitFor();
 await page.getByText('All handled').waitFor();
 const flow=await db.selectFrom('workflows').select(['id','status']).where('customer_id','=',customer.id).executeTakeFirstOrThrow();
 if(flow.status!=='active')throw new Error(`Workflow status ${flow.status}`);
 const runs=await db.selectFrom('workflow_runs').select('subject_email').where('workflow_id','=',flow.id).orderBy('subject_email').execute();
 if(JSON.stringify(runs.map(r=>r.subject_email))!==JSON.stringify(['lena@northwind.example.test','omar@northwind.example.test','priya@northwind.example.test']))throw new Error(`Enrolled: ${runs.map(r=>r.subject_email)}`);
 const templates=await db.selectFrom('templates').select('name').where('customer_id','=',customer.id).orderBy('name').execute();
 if(templates.length!==2)throw new Error(`Saved templates: ${templates.map(t=>t.name)}`);
 console.log('Browser: launch published the workflow, saved both emails and enrolled exactly the 3 consented contacts');
 await page.screenshot({path:`${out}/2-campaign-launched.png`,fullPage:true});

 // 4. Reload: the decisions are durable and the saved records are linked.
 await page.reload();
 await page.getByText('Live · 3 contacts enrolled').waitFor({timeout:30000});
 const links=await page.getByRole('link',{name:'Open'}).evaluateAll(as=>as.map(a=>a.getAttribute('href')));
 if(!links.some(h=>h?.startsWith('/workflow-builder?id=')) || !links.some(h=>h?.startsWith('/email-builder?id=')))throw new Error(`Links: ${links}`);
 console.log('Browser: reload keeps every decision with links to the saved segment, emails and workflow');
 if(errors.length)throw new Error(`Page errors: ${errors.join(' | ')}`);
 console.log('AI campaign browser acceptance passed. Screenshots in',out);
}catch(error){failed=true;console.error('FAILED:',error);console.error('API and AI worker log tail:\n'+logs.slice(-3000));await browser?.contexts()[0]?.pages()[0]?.screenshot({path:`${out}/failure.png`}).catch(()=>{});}
finally{
 await browser?.close();for(const p of [api,worker])p?.kill();await ui.close();llm.close();
 if(customer){await db.deleteFrom('customers').where('id','=',customer.id).execute();await db.deleteFrom('users').where('id','=',user.id).execute();}
 await closeQueues().catch(()=>{});await closeRedis().catch(()=>{});await closeDb();
 process.exit(failed?1:0);
}
