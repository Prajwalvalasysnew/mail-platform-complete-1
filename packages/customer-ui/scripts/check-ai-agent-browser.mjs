// Production-bundle browser acceptance for the template-editor AI agent.
// Replays the conversation that exposed the old structured-draft approach through the real UI, API,
// BullMQ queue, AI worker and DeepSeek Harness runtime, using a scripted OpenAI-compatible model.
// Build shared/api/worker/customer-ui first, then from the repo root:
//   DATABASE_URL=.../mail_test QUEUE_PREFIX=ai_browser_agent_ node packages/customer-ui/scripts/check-ai-agent-browser.mjs
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import shared from '@platform/shared';
import {accountRoutes} from '@platform/api/routes/account.js';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {consoleDataRoutes} from '@platform/api/routes/console-data.js';
const {db,createUserSession,closeQueues,closeDb,closeRedis,aiQueue}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL).pathname))throw new Error('Browser verification requires the isolated mail_test database');
if(!/^ai_browser_[a-z0-9_]+$/.test(process.env.QUEUE_PREFIX || ''))throw new Error('Browser verification requires a dedicated ai_browser_ queue prefix');
const out='packages/customer-ui/test-results/ai-agent';await mkdir(out,{recursive:true});

// Scripted model: behaves like a tool-calling model would for each request in the conversation.
const text=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map(p=>p.text || '').join(''):'';
const ask=messages=>{for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]);if(messages[i].role!=='user')continue;if(/^Verification:/.test(t))return t;const at=t.lastIndexOf('User request:\n');if(at>=0)return t.slice(at+14);}return '';};
const latestDoc=messages=>{for(let i=messages.length-1;i>=0;i--){const t=text(messages[i]);if(/data-ai="e\d+"/.test(t))return t;}return '';};
const results=messages=>{const r=[];for(let i=messages.length-1;i>=0 && messages[i].role==='tool';i--)r.unshift(text(messages[i]));return r;};
const id=(doc,re)=>{const m=doc.match(re);if(!m)throw new Error(`fixture could not find ${re}`);return m[1];};
const DESIGN=`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2ff;font-family:Arial,Helvetica,sans-serif"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="padding:48px;background-color:#1e1b4b;color:#ffffff"><p style="margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#a5b4fc">VALASYS AI</p><h1 style="margin:0;font-size:34px;line-height:1.2;color:#ffffff">Meet VAIS: know who is ready to buy</h1><p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:#c7d2fe">Intent intelligence that helps your team prioritise the right accounts.</p></td></tr>
<tr><td style="padding:32px 48px"><h2 style="margin:0 0 8px;font-size:20px;color:#1e1b4b">Why teams choose VAIS</h2><p style="margin:0;font-size:15px;line-height:1.6;color:#374151">Prioritise accounts, personalise outreach and focus on pipeline that converts.</p></td></tr>
<tr><td style="padding:24px 48px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb"><a href="{{unsubscribe_url}}" style="color:#6b7280">Unsubscribe</a></td></tr>
</table></td></tr></table>`;
function model(messages){
 const q=ask(messages),done=results(messages),doc=latestDoc(messages);
 if(/attractive email template/.test(q))return done.length?{content:'I created a premium launch email for VAIS with a hero, benefits and footer.'}:{calls:[['write_email',{html:DESIGN}],['set_subject',{subject:'Meet VAIS: intent data that converts',preheader:'See which accounts are ready to buy.'}]]};
 if(/add good cta/.test(q))return done.length?{content:'I added a “Book your demo” button and changed the background to orange. Send me the link and I will connect the button.'}:{calls:[
  ['update_element',{id:id(doc,/<table[^>]*data-ai="(e\d+)"/),styles:{'background-color':'#f97316'}}],
  ['insert_html',{id:id(doc,/<p[^>]*data-ai="(e\d+)"[^>]*>Prioritise/),position:'after',html:'<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px"><tr><td bgcolor="#f97316" style="border-radius:8px;background-color:#f97316"><a href="#" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none">Book your demo</a></td></tr></table>'}]]};
 if(/valasys\.com\/product/.test(q))return done.length?{content:'The “Book your demo” button now links to https://valasys.com/product. Nothing else changed.'}:{calls:[['update_element',{id:id(doc,/<a href="#"[^>]*data-ai="(e\d+)"/),attributes:{href:'https://valasys.com/product'}}]]};
 if(/make this green/.test(q)){
  if(done.length)return {content:'The selected button is now green.'};
  const all=messages.map(text).join('\n'),selected=all.match(/The user has selected link “Book your demo” \((e\d+)\)/)?.[1];
  if(!selected)return {content:'I do not know which element you mean.'};
  return {calls:[['update_element',{id:selected,styles:{'background-color':'#16a34a'}}]]};
 }
 if(/remember our website/.test(q))return done.length?{content:'I will remember valasys.com for every email from now on.'}:{calls:[['remember',{facts:[{fact:'Website: https://valasys.com',topic:'Website'}]}]]};
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
process.env.AI_ENABLED='true';process.env.AI_BASE_URL='http://127.0.0.1:3102';process.env.AI_MODEL='fixture-model';process.env.AI_ALLOW_PRIVATE_HTTP='true';

const app=Fastify(),email=`ai-agent-browser-${randomUUID()}@example.test`;
let browser,worker,customer,user,failed=false;
try{
 customer=await db.insertInto('customers').values({email,name:'Synthetic AI agent check',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Synthetic AI agent check'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 process.env.AI_ENABLED_TENANTS=customer.id;
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 await app.register(accountRoutes,{prefix:'/v1'});await app.register(accountAiRoutes,{prefix:'/v1/account/ai'});await app.register(consoleDataRoutes,{prefix:'/v1/account/data'});
 app.route({url:'/api/*',method:['GET','POST','PUT','PATCH','DELETE'],handler:async(req,reply)=>{const r=await app.inject({method:req.method,url:req.url.replace(/^\/api/,'/v1'),headers:req.headers,payload:req.body});return reply.code(r.statusCode).headers(r.headers).send(r.body);}});
 app.get('/assets/:file',async(req,reply)=>{const file=req.params.file;if(!/^[\w.-]+$/.test(file))return reply.code(404).send();const type={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';return reply.type(type).send(await readFile(path.join('packages/customer-ui/dist/assets',file)));});
 app.get('/email-builder',async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
 app.get('/ai-agent',async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
 await app.listen({port:3101,host:'127.0.0.1'});
 worker=spawn(process.execPath,['packages/worker/dist/ai-worker.js'],{env:{...process.env,AI_HEALTH_PORT:'19104'},stdio:['ignore','ignore','pipe']});
 let workerLog='';worker.stderr.on('data',d=>{workerLog=(workerLog+d).slice(-4000);});

 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 await page.goto('http://127.0.0.1:3101/email-builder');
 await page.locator('.gjs-frame').waitFor({timeout:45000});
 const frame=page.frameLocator('.gjs-frame');
 await page.getByRole('button',{name:'✦ AI',exact:true}).click();
 const say=async(message,expectText)=>{
  await page.getByLabel('Message the AI assistant').fill(message);
  await page.getByLabel('Message the AI assistant').press('Enter');
  await page.locator('[data-editor-ai-conversation]').getByText(expectText).first().waitFor({timeout:90000});
  await page.locator('[data-editor-ai-conversation] [role=status]').waitFor({state:'hidden',timeout:90000});
  console.log(`Browser: "${message}" -> ${expectText}`);
 };
 await say('I want you to create highly attractive email template in html for valasys ai product vais','premium launch email');
 await frame.getByText('Meet VAIS: know who is ready to buy').waitFor();
 await page.screenshot({path:`${out}/1-created.png`});

 await say("add good cta and also change the temlate's bg to orange",'Book your demo');
 const cta=frame.getByRole('link',{name:'Book your demo'});await cta.waitFor();
 const bg=await frame.locator('table').first().evaluate(el=>getComputedStyle(el).backgroundColor);
 if(bg!=='rgb(249, 115, 22)')throw new Error(`Background is ${bg}, expected orange`);
 for(const kept of ['Meet VAIS: know who is ready to buy','Why teams choose VAIS','Prioritise accounts, personalise outreach'])await frame.getByText(kept).waitFor();
 if(!(await page.locator('[data-editor-ai-conversation]').innerText()).includes('• Updated email background'))throw new Error('Change list not shown in the conversation');
 await page.screenshot({path:`${out}/2-cta-orange.png`});

 await say('use this one "https://valasys.com/product"','now links to https://valasys.com/product');
 if(await cta.getAttribute('href')!=='https://valasys.com/product')throw new Error(`CTA href is ${await cta.getAttribute('href')}`);
 await page.screenshot({path:`${out}/3-linked.png`});

 await page.getByRole('button',{name:'Undo',exact:true}).click();
 if(await frame.getByRole('link',{name:'Book your demo'}).getAttribute('href')!=='#')throw new Error('Undo did not restore the previous step');
 console.log('Browser: Undo restored the previous canvas');
 // "this" means the block selected on the canvas.
 await frame.getByRole('link',{name:'Book your demo'}).click();
 await say('make this green','The selected button is now green');
 const green=await frame.getByRole('link',{name:'Book your demo'}).evaluate(el=>getComputedStyle(el).backgroundColor);
 if(green!=='rgb(22, 163, 74)')throw new Error(`Selected button is ${green}, expected green`);
 if(await frame.locator('.vx-ai-selected').count())throw new Error('Selection marker leaked into the email');
 console.log('Browser: "make this green" changed the block selected on the canvas');
 await page.screenshot({path:`${out}/4-selected-green.png`});

 // Memory: remembered once in the editor, visible and editable on the AI agent page.
 await say('remember our website is valasys.com','I will remember valasys.com');
 await page.goto('http://127.0.0.1:3101/ai-agent');
 await page.getByText('Memory',{exact:true}).first().click();
 await page.getByText('Website: https://valasys.com').waitFor({timeout:30000});
 await page.screenshot({path:`${out}/5a-memory-open.png`,fullPage:true});
 const voice=page.locator('textarea').nth(1);
 await voice.fill('Clear, confident, no hype');
 await page.waitForTimeout(1500);
 await page.reload();
 await page.getByText('Memory',{exact:true}).first().click();
 await page.getByText('Website: https://valasys.com').waitFor({timeout:30000});
 const kept=await page.locator('textarea').nth(1).inputValue();
 if(kept!=='Clear, confident, no hype')throw new Error(`Brand voice after reload: ${kept}`);
 const stored=await db.selectFrom('ai_workspace_memory').select('memory').where('customer_id','=',customer.id).executeTakeFirstOrThrow();
 if(stored.memory.voice!=='Clear, confident, no hype')throw new Error('Memory edit was not saved');
 console.log('Browser: a fact remembered in the editor shows on the AI agent page, and Memory edits persist');
 await page.screenshot({path:`${out}/5-memory.png`,fullPage:true});
 if(errors.length)throw new Error(`Page errors: ${errors.join(' | ')}`);
 console.log('AI agent browser acceptance passed. Screenshots in',out);
}catch(error){failed=true;console.error('FAILED:',error);}
finally{
 await browser?.close();if(worker){worker.kill();await new Promise(r=>setTimeout(r,500));}
 await app.close();llm.close();
 if(customer){await db.deleteFrom('customers').where('id','=',customer.id).execute();await db.deleteFrom('users').where('id','=',user.id).execute();}
 await aiQueue.obliterate({force:true}).catch(()=>{});await aiQueue.close();await closeQueues();await closeRedis();await closeDb();
 process.exit(failed?1:0);
}
