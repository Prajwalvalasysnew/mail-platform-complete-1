// Production-bundle browser acceptance for Valasys AI outside the template editor: the workflow
// builder's AI panel and the page-aware assistant drawer. Runs the real API server, AI worker and
// DeepSeek Harness against a scripted OpenAI-compatible model.
// Build shared/api/worker/customer-ui first, then from the repo root:
//   node --env-file=.env.test [--env-file=.env.test.local] packages/customer-ui/scripts/check-ai-everywhere-browser.mjs
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
const out='packages/customer-ui/test-results/ai-everywhere';await mkdir(out,{recursive:true});
const prefix=`ai_browser_everywhere_${Date.now()}_`;

const text=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map(p=>p.text || '').join(''):'';
const ask=messages=>{for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]);if(messages[i].role!=='user')continue;if(/^Verification:/.test(t))return t;const at=t.lastIndexOf('User request:\n');if(at>=0)return t.slice(at+14);}return '';};
const results=messages=>{const r=[];for(let i=messages.length-1;i>=0 && messages[i].role==='tool';i--)r.unshift(text(messages[i]));return r;};
function model(messages){
 const q=ask(messages),done=results(messages),all=messages.map(text).join('\n'),template=all.match(/^([0-9a-f-]{36}): Win-back offer/m)?.[1];
 if(/win-back/i.test(q))return done.length?{content:'I built a win-back workflow: when someone clicks, wait 2 days, send “Win-back offer”, then wait for an open.'}:{calls:[['build_workflow',{name:'Win-back journey',trigger:'clicked',steps:[{t:'wait',mode:'duration',amount:2,unit:'days'},{t:'email',template},{t:'wait',mode:'event',event:'opened',max:3}]}]]};
 if(/onboarding workflow/i.test(q))return done.length?{content:'Here is an onboarding workflow draft for you to review.'}:{calls:[['build_workflow',{name:'Onboarding',trigger:'event',steps:[{t:'email',template},{t:'wait',mode:'duration',amount:1,unit:'days'}]}]]};
 if(/connected domains/i.test(q))return done.length?{content:`You have ${JSON.parse(done[0]).data.connected} connected sending domains and ${JSON.parse(done[0]).data.verified} are verified.`}:{calls:[['read_workspace',{tool:'domain_status'}]]};
 return {content:'I can help with that.'};
}
let callNo=0;
const llm=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),tools=(body.tools||[]).map(t=>t.function.name),turn=model(body.messages||[]);
 const calls=(turn.calls||[]).map(([name,args])=>({id:`c${++callNo}`,type:'function',function:{name:tools.find(t=>t.endsWith(`__${name}`))||name,arguments:JSON.stringify(args)}}));
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:calls.length?{role:'assistant',tool_calls:calls.map((c,index)=>({index,...c}))}:{role:'assistant',content:turn.content},finish_reason:null}]})}\n\n`);
 res.write(`data: ${JSON.stringify({id:'r',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\n`);
 res.end('data: [DONE]\n\n');});});
await new Promise(r=>llm.listen(3102,'127.0.0.1',r));

const email=`ai-everywhere-${randomUUID()}@example.test`;
let customer,user,api,worker,browser,failed=false;const ui=Fastify();
try{
 customer=await db.insertInto('customers').values({email,name:'Synthetic AI everywhere check',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Synthetic AI everywhere check'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 await db.insertInto('templates').values({customer_id:customer.id,name:'Win-back offer',subject:'We miss you',html_body:'<p>Come back</p>',text_body:'Come back'}).execute();
 await db.insertInto('sending_domains').values([1,2,3].map(n=>({customer_id:customer.id,domain:`d${n}-${customer.id}.example.test`,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),...(n===1?{verified_at:new Date()}:{})}))).execute();
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const env={...process.env,QUEUE_PREFIX:prefix,API_PORT:'3011',AI_ENABLED:'true',AI_BASE_URL:'http://127.0.0.1:3102',AI_MODEL:'fixture-model',AI_ALLOW_PRIVATE_HTTP:'true',AI_ENABLED_TENANTS:customer.id,AI_HEALTH_PORT:'19105'};
 let logs='';const keep=d=>{logs=(logs+d).slice(-6000);};
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

 // 1. Workflow builder AI panel.
 await page.goto('http://127.0.0.1:3101/workflow-builder');
 await page.getByText('Saved to workspace').or(page.getByText('New unsaved draft')).first().waitFor({timeout:45000});
 await page.getByRole('button',{name:'✦ AI',exact:true}).click();
 await page.locator('textarea[placeholder^="e.g. Remind"]').fill('Set up a win-back journey for people who click our emails');
 await page.getByRole('button',{name:/Draft workflow/}).click();
 await page.locator('[data-editor-ai-conversation]').getByText('I built a win-back workflow').waitFor({timeout:90000});
 await page.getByText('Win-back journey').first().waitFor();
 await page.getByText('Saved to workspace').waitFor({timeout:20000});
 const saved=await db.selectFrom('workflows').select(['builder_document']).where('customer_id','=',customer.id).executeTakeFirstOrThrow();
 const types=saved.builder_document.graph.nodes.map(n=>n.t);
 if(JSON.stringify(types)!==JSON.stringify(['trigger','wait','email','wait']))throw new Error(`Saved workflow steps: ${types}`);
 console.log('Browser: workflow builder AI built and autosaved the workflow draft',types.join(' → '));
 await page.screenshot({path:`${out}/1-workflow-builder.png`});

 // 2. Page-aware assistant drawer on Settings and Automations.
 await page.goto('http://127.0.0.1:3101/domains');
 await page.getByRole('button',{name:/Ask AI/}).first().click();
 const drawer=page.getByPlaceholder('Ask about your sends, contacts or deliverability…');
 await drawer.fill('How many connected domains do I have?');await drawer.press('Enter');
 await page.getByText('You have 3 connected sending domains and 1 are verified.').waitFor({timeout:90000});
 console.log('Browser: assistant drawer answered from workspace data');
 await page.screenshot({path:`${out}/2-drawer-answer.png`});
 await page.goto('http://127.0.0.1:3101/automations');
 await page.getByRole('button',{name:/Ask AI/}).first().click();
 await drawer.fill('Draft an onboarding workflow for new signups');await drawer.press('Enter');
 await page.getByText('Here is an onboarding workflow draft').waitFor({timeout:90000});
 await page.getByText('Review workflow draft').waitFor();
 console.log('Browser: assistant drawer drafted a workflow with a review action');
 await page.screenshot({path:`${out}/3-drawer-workflow.png`});
 if(errors.length)throw new Error(`Page errors: ${errors.join(' | ')}`);
 console.log('AI everywhere browser acceptance passed. Screenshots in',out);
}catch(error){failed=true;console.error('FAILED:',error);}
finally{
 await browser?.close();for(const p of [api,worker])p?.kill();await ui.close();llm.close();
 if(customer){await db.deleteFrom('customers').where('id','=',customer.id).execute();await db.deleteFrom('users').where('id','=',user.id).execute();}
 await closeQueues().catch(()=>{});await closeRedis().catch(()=>{});await closeDb();
 process.exit(failed?1:0);
}
