// Synthetic production-bundle browser check against isolated test DB/Redis.
// Build the customer UI first, then run with node --env-file=.env from repo root.
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import shared from '@platform/shared';
import {accountRoutes} from '@platform/api/routes/account.js';
import {accountAiRoutes} from '@platform/api/routes/account-ai.js';
import {consoleDataRoutes} from '@platform/api/routes/console-data.js';
const {db,createUserSession,closeQueues,closeDb,closeRedis,aiQueue}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL).pathname))throw new Error('Browser verification requires the isolated mail_test database');
if(!/^ai_browser_[a-z0-9_]+$/.test(process.env.QUEUE_PREFIX || ''))throw new Error('Browser verification requires a dedicated ai_browser_ queue prefix');
const app=Fastify(),email=`ai-browser-${randomUUID()}@example.test`;
let browser,worker,customer,user,page;
const syntheticProvider=process.env.AI_BROWSER_SYNTHETIC_PROVIDER==='true';
let contextTemplate;
let lostAcknowledgement=true,pollOutage=true;const submittedIds=[];
try{
  customer=await db.insertInto('customers').values({email,name:'Synthetic AI browser check',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
  user=await db.insertInto('users').values({email,name:'Synthetic AI browser check'}).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
  process.env.AI_ENABLED_TENANTS=customer.id;
  const session=await createUserSession(user.id,{currentCustomerId:customer.id});
  contextTemplate=await db.insertInto('templates').values({customer_id:customer.id,name:'AI context fixture',subject:'CEDAR-482 source',text_body:'Synthetic reference content.',html_body:null}).returning('id').executeTakeFirstOrThrow();
  if(syntheticProvider){
    process.env.AI_BASE_URL='http://127.0.0.1:3101/fixture-llm';process.env.AI_ALLOW_PRIVATE_HTTP='true';
    app.post('/fixture-llm/api/chat',async req=>{
      const input=JSON.parse(req.body.messages[1].content);let result;
      if(input.operation==='route')result={calls:[]};
      else if(input.operation==='compact')result={summary:'The project codename is ORCHID-731. A dashboard announcement is being prepared.'};
      else if(input.operation==='subjects')result={subjects:['A useful dashboard update','Your dashboard update is here','Explore the updated dashboard']};
      else if(input.operation==='rewrite')result={text:input.content};
      else {
       const isConversation=['assist','editor'].includes(input.operation),context=JSON.parse(input.content || '{}'),source=context.workspace_observations?.find(x=>x.tool==='read_template');
       if(input.operation==='editor' && /^Synthetic dashboard update\n=/.test(context.settings.editor.content))throw new Error('Editor snapshot incorrectly includes subject metadata');
       const draft={subject:'Synthetic dashboard update',preheader:'Explore the dashboard',design:{theme:'ocean',layout:'showcase',eyebrow:'DASHBOARD UPDATE',footer:''},blocks:[{type:'heading',text:'A dashboard update',url:''},{type:'paragraph',text:'Our redesigned dashboard is available. Thank you for your feedback.',url:''}]};
       const text=source?.data?.subject || (/codename/i.test(input.instruction)?'ORCHID-731':'Write a clear subject and explain the announcement briefly.');
       const wantsDraft=input.operation==='draft' || input.operation==='editor' && !/^why|^what|^can you explain/i.test(input.instruction) || input.operation==='assist' && /^write an email/i.test(input.instruction);
       result=isConversation?{reply:wantsDraft?'Prepared your email draft.':text,draft:wantsDraft?draft:null}:input.operation==='draft'?draft:{text};
      }
      return {done:true,done_reason:'stop',message:{content:JSON.stringify(result)},prompt_eval_count:100,eval_count:30};
    });
  }

  await app.register(accountRoutes,{prefix:'/v1'});await app.register(accountAiRoutes,{prefix:'/v1/account/ai'});await app.register(consoleDataRoutes,{prefix:'/v1/account/data'});
  app.route({url:'/api/*',method:['GET','POST','PUT','PATCH','DELETE'],handler:async(req,reply)=>{
    const response=await app.inject({method:req.method,url:req.url.replace(/^\/api/,'/v1'),headers:req.headers,payload:req.body});
    if((req.url==='/api/account/ai/generations' || /^\/api\/account\/ai\/chats\/[^/]+\/turns$/.test(req.url)) && req.method==='POST'){
      submittedIds.push(req.body.request_id);
      if(lostAcknowledgement && response.statusCode===202){lostAcknowledgement=false;return reply.code(503).send({error:'synthetic_lost_acknowledgement'});}
    }
    if(req.url.startsWith('/api/account/ai/runs/') && req.method==='GET' && pollOutage){pollOutage=false;return reply.code(503).send({error:'synthetic_poll_outage'});}
    return reply.code(response.statusCode).headers(response.headers).send(response.body);
  }});
  app.get('/assets/:file',async(req,reply)=>{
    const file=req.params.file;if(!/^[\w.-]+$/.test(file))return reply.code(404).send();
    const ext=path.extname(file),type={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.svg':'image/svg+xml'}[ext] || 'application/octet-stream';
    return reply.type(type).send(await readFile(path.join(process.cwd(),'packages/customer-ui/dist/assets',file)));
  });
  for(const route of ['/ai-agent','/email-builder'])app.get(route,async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
  await app.listen({port:3101,host:'127.0.0.1'});
  worker=spawn(process.execPath,['packages/worker/dist/ai-worker.js'],{cwd:process.cwd(),env:{...process.env,AI_HEALTH_PORT:'19103'},stdio:['ignore','ignore','pipe'],windowsHide:true});
  // Never forward worker stderr: retain only whether the process exits unexpectedly.
  worker.stderr.on('data',()=>{});
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
  page=await context.newPage();page.setDefaultTimeout(20000);
  let lastStatus='';
  page.on('response',async response=>{
    if(response.url().includes('/account/data/templates') && response.request().method()==='POST')console.log('Browser template save response:',response.status());
    if(!response.url().includes('/account/ai/'))return;
    try{const body=await response.json(),state=`${response.status()}:${body.status || body.error || 'capabilities'}`;if(state!==lastStatus){lastStatus=state;console.log('Browser AI response:',state,body.result?.operation || '');}}catch{/* Non-JSON errors are captured by the UI. */}
  });
  page.on('pageerror',error=>{errors.push(error.message);console.error('Browser page error:',error.message.slice(0,180));});
  page.on('console',message=>{if(message.type()==='error' && !message.text().startsWith('Failed to load resource:') && !message.text().startsWith('Warning: Invalid DOM property')){errors.push(message.text());console.error('Browser console error:',message.text().slice(0,180));}});
  await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
  const origin=process.env.AI_BROWSER_ORIGIN || 'http://127.0.0.1:3101';
  await page.goto(`${origin}/ai-agent`);
  console.log('Browser: opened AI workspace');
  await page.getByPlaceholder(/Ask anything/).fill('Explain how to write a clear email announcement in two sentences.');
  await page.getByTitle('Send (Enter)',{exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden',timeout:120000});
  await page.waitForFunction(()=>document.body.innerText.includes('Worked for'));
  if(submittedIds.length<2 || submittedIds[0]!==submittedIds[1])throw new Error('Lost acknowledgement retry changed the idempotency key');
  console.log('Browser: original AI design returned a real chat response after transient submission and polling failures');
  await page.reload();
  await page.getByRole('main').getByText('Explain how to write a clear email announcement in two sentences.',{exact:true}).waitFor();
  await page.getByPlaceholder(/Ask anything/).fill('Remember: the project codename is ORCHID-731. Acknowledge it briefly.');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByTitle('Send (Enter)',{exact:true}).click()]);
  const beforeResume=submittedIds.length;await page.reload();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.includes('Worked for')).length>=2,{},{timeout:120000});
  if(submittedIds.length!==beforeResume)throw new Error('Refresh submitted a duplicate chat turn');
  await page.getByPlaceholder(/Ask anything/).fill('/compact');
  await page.getByTitle('Send (Enter)',{exact:true}).click();
  await page.getByText('Earlier context has been compacted. Your full chat history is preserved.',{exact:true}).waitFor({timeout:120000});
  await page.reload();
  await page.getByText('Earlier context has been compacted. Your full chat history is preserved.',{exact:true}).waitFor();
  await page.getByPlaceholder(/Ask anything/).fill('What is our project codename? Reply with the codename only.');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByTitle('Send (Enter)',{exact:true}).click()]);
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden',timeout:120000});
  await page.getByText('ORCHID-731',{exact:true}).last().waitFor({timeout:120000});
  console.log('Browser: history restored after reload and codename survived compaction');
  await page.getByTitle('Add context',{exact:true}).click();
  console.log('Browser: opened original context menu');
  await page.getByText('AI context fixture',{exact:true}).click();
  console.log('Browser: selected actual tenant template');
  await page.getByPlaceholder(/Ask anything/).fill('Quote the exact subject of the selected template only.');
  await page.getByTitle('Send (Enter)',{exact:true}).click();
  await page.getByRole('main').getByText('CEDAR-482 source',{exact:true}).waitFor({timeout:120000});
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden',timeout:120000});
  console.log('Browser: original context picker supplied a real tenant template');
  await page.getByPlaceholder(/Ask anything/).fill('Write an email announcement: our redesigned dashboard is now available. One heading and one short paragraph. No links, discounts or deadlines.');
  await page.getByTitle('Send (Enter)',{exact:true}).click();
  const approve=page.getByRole('button',{name:'Approve',exact:true}).first();
  await approve.waitFor({timeout:120000});
  await Promise.all([page.waitForResponse(r=>r.url().includes('/decision') && r.request().method()==='POST'),approve.click()]);
  await page.getByRole('link',{name:/^Open/}).waitFor();
  await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});
  await page.screenshot({path:'packages/customer-ui/test-results/ai-live/writing-status.png',fullPage:true});
  await page.getByRole('link',{name:/^Open/}).click();
  await page.locator('.gjs-frame').waitFor({timeout:45000});
  await page.waitForFunction(()=>document.querySelector('.gjs-frame')?.contentDocument?.body?.innerText.trim().length>0);
  console.log('Browser: existing approval saved a draft and opened the editor');
  await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});
  await page.screenshot({path:'packages/customer-ui/test-results/ai-live/saved-draft.png',fullPage:true});
  const subjectInput=page.locator('label').filter({has:page.getByTitle('Suggest subject lines with AI',{exact:true})}).locator('input');
  const originalSubject=await subjectInput.inputValue();
  await page.getByTitle('Suggest subject lines with AI',{exact:true}).click();
  // Original dropdown renders generated options as buttons with their character counts.
  await page.waitForResponse(async r=>{if(!r.url().includes('/account/ai/runs/'))return false;try{return (await r.json()).result?.operation==='subjects';}catch{return false;}},{timeout:120000});
  await page.getByRole('button').filter({hasText:/\d+$/}).filter({has:page.locator('span')}).last().click();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  if(await subjectInput.inputValue()!==originalSubject)throw new Error('Subject Undo did not restore the original subject');
  const paragraph=page.frameLocator('.gjs-frame').locator('p').first();
  const before=await paragraph.innerText();await paragraph.click();
  await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();
  await page.getByRole('button',{name:'Rewrite',exact:true}).click();
  await page.getByRole('button',{name:'Shorter',exact:true}).click();
  await page.waitForResponse(async r=>{if(!r.url().includes('/account/ai/runs/'))return false;try{return (await r.json()).result?.operation==='rewrite';}catch{return false;}},{timeout:120000});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  if(await paragraph.innerText()!==before)throw new Error('Rewrite undo did not restore the original paragraph');
  await page.getByRole('button',{name:'Write',exact:true}).click();
  const beforeQuestion=await page.frameLocator('.gjs-frame').locator('body').innerText();
  await page.getByPlaceholder(/Ask a question/).fill('Why should the subject be clear?');
  await page.getByRole('button',{name:/Generate email|Send message/}).click();
  await page.getByRole('log').getByText('Write a clear subject and explain the announcement briefly.',{exact:true}).waitFor({timeout:120000});
  if(await page.frameLocator('.gjs-frame').locator('body').innerText()!==beforeQuestion)throw new Error('Conversational answer changed the canvas');
  await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
  await page.getByPlaceholder(/Ask a question/).fill('Synthetic editor test: announce the dashboard update. One heading and one paragraph, no links or invented features.');
  await page.getByRole('button',{name:/Generate email|Send message/}).click();
  await page.waitForResponse(async r=>{if(!r.url().includes('/account/ai/runs/'))return false;try{return (await r.json()).result?.operation==='draft';}catch{return false;}},{timeout:120000});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  const frameText=()=>page.frameLocator('.gjs-frame').locator('body').innerText();
  const originalEmail=await frameText();
  await page.getByRole('button',{name:'Add a section',exact:true}).click();
  await page.locator('textarea').fill('Add one short paragraph thanking readers for their feedback. No links, claims or invented facts.');
  await page.getByRole('button',{name:/Add section|Send message/}).click();
  await page.waitForResponse(async r=>{if(!r.url().includes('/account/ai/runs/'))return false;try{return (await r.json()).result?.operation==='draft';}catch{return false;}},{timeout:120000});
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  if(await frameText()!==originalEmail)throw new Error('Section Undo did not restore the original email');
  // User edits made during inference must survive the late response.
  await page.getByRole('button',{name:'Full email',exact:true}).click();
  await page.getByPlaceholder(/Ask a question/).fill('Synthetic stale edit test: a short dashboard update, no links.');
  await page.getByRole('button',{name:/Generate email|Send message/}).click();
  const preheader=page.getByPlaceholder('Shown after the subject in the inbox');
  await preheader.fill('User edit while AI is writing');
  await page.getByText('The email changed while AI was writing. Generate again from the latest content.',{exact:true}).waitFor({timeout:120000});
  if(await frameText()!==originalEmail || await preheader.inputValue()!=='User edit while AI is writing')throw new Error('Late response overwrote user edits');
  await page.screenshot({path:'packages/customer-ui/test-results/ai-live/editor-conversation.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.reload();
  await page.locator('.gjs-frame').waitFor({timeout:45000});
  await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();
  await page.getByRole('log').getByText('Why should the subject be clear?',{exact:true}).waitFor({timeout:45000});
  if(await frameText()!==originalEmail)throw new Error('Reload silently applied an AI draft over the saved email');
  await page.screenshot({path:'packages/customer-ui/test-results/ai-live/editor-history-restored.png',fullPage:true});
  if(errors.length)throw new Error('Customer UI emitted browser errors');
  console.log(JSON.stringify({browser:'passed',provider:syntheticProvider?'synthetic':'hosted',checks:['original AI design','chat','draft','existing approval saves template','editor load','original subject dropdown','selected-text rewrite','editor draft','existing Undo','section generation','late-edit protection','idempotent retry after lost acknowledgement','poll outage recovery','history after reload','manual compaction','fact recall after compaction','refresh resumes existing run without duplicate submission','existing context picker','grounded selected template reply','editor conversation answers without canvas changes','editor follow-up draft','editor history after reload'],screenshots:'packages/customer-ui/test-results/ai-live'}));
}catch(error){
  await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});
  await page?.screenshot({path:'packages/customer-ui/test-results/ai-live/failure.png',fullPage:true}).catch(()=>{});
  throw error;
}finally{
  await browser?.close();
  if(worker){worker.kill();await Promise.race([new Promise(resolve=>worker.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(worker.exitCode===null)worker.kill('SIGKILL');}
  await app.close();
  if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();
  if(user)await db.deleteFrom('users').where('id','=',user.id).execute();
  await aiQueue.obliterate({force:true});await closeQueues();await closeRedis().catch(()=>undefined);await closeDb();
}
