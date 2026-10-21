// End-to-end quality checks through the running local application and actual AI worker.
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import shared from '@platform/shared';
const {db,withTenant,createUserSession,closeDb,closeQueues,closeRedis}=shared;
if(process.env.AI_QUALITY_LOCAL_STACK!=='true' || !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname) || new URL(process.env.DATABASE_URL).pathname!=='/mail_platform')throw new Error('Explicit local application QA configuration required');
let customer,user,browser;
try{
 const email=`ai-quality-${randomUUID()}@example.test`;
 customer=await db.insertInto('customers').values({email,name:'AI quality verification',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'AI quality verification'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 await withTenant(customer.id,trx=>trx.insertInto('sending_domains').values(Array.from({length:23},(_,n)=>({customer_id:customer.id,domain:`quality-${n}.example.test`,dkim_selector:'s1',dkim_public_key:'synthetic',dkim_private_key:'synthetic-not-a-key',verification_token:randomUUID()}))).execute());
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const auth=await fetch('http://localhost:8080/api/auth/me',{headers:{Authorization:`Bearer ${session.token}`}});if(!auth.ok)throw new Error('Local QA session was not accepted; use the running API human-session pepper.');
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const context=await browser.newContext({viewport:{width:1440,height:1080}});
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 const page=await context.newPage();page.setDefaultTimeout(120000);page.on('dialog',dialog=>dialog.accept());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://localhost:8080/ai-agent');
 async function askAgent(text,expected){await page.getByPlaceholder(/Ask anything/).fill(text);await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByTitle('Send (Enter)',{exact:true}).click()]);await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});const chatId=new URL(page.url()).searchParams.get('chat');const saved=await shared.getAiChat(customer.id,user.id,chatId),last=saved.messages.at(-1);if(last.status!=='completed' || !expected.test(last.text))throw new Error('Live agent answer failed quality check');console.log(JSON.stringify({check:text,status:'passed'}));}
 await askAgent("how many domain's I have connected?",/23/);
 await askAgent('and how many are verified?',/\b0\b|none|no domains/i);
 await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-domain-answer.png',fullPage:true});
 await page.goto('http://localhost:8080/email-builder');await page.locator('.gjs-frame').waitFor();await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();
 const prompt=page.getByPlaceholder(/Ask a question/);
 async function askEditor(text,wantsDraft){await prompt.fill(text);await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByRole('button',{name:/Generate email|Send message/}).click()]);await page.getByRole('button',{name:'Send message',exact:true}).waitFor();const id=new URL(page.url()).searchParams.get('ai_chat'),saved=await shared.getAiChat(customer.id,user.id,id),last=saved.messages.at(-1);if(last.status!=='completed' || last.result?.operation!==(wantsDraft?'draft':'chat')){console.log(JSON.stringify({check:text,status:last.status,operation:last.result?.operation,error:last.error,reply:(last.result?.message || last.text || '').slice(0,700)}));await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-quality-failure.png',fullPage:true});throw new Error('Live editor turn failed quality check');}return last;}
 const draft=await askEditor('Create high quality product demo html template',true);if(!draft.result.html.includes('role="presentation"') || /dear|\{\{|urgent:/i.test(draft.text))throw new Error('Product demo quality regression');
 await page.frameLocator('.gjs-frame').locator('h1').waitFor();await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-product-demo.png',fullPage:true});console.log(JSON.stringify({check:'exact product-demo request',status:'passed'}));
 const changed=await askEditor('Use the ocean color theme and keep this exact phrase: CEDAR-482 preview.',true);if(changed.result.design?.theme!=='ocean' || !changed.text.includes('CEDAR-482 preview'))throw new Error('Editor follow-up did not respect requested facts');
 const body=()=>page.frameLocator('.gjs-frame').locator('body').innerText();const before=await body();await askEditor('Why did you choose this layout? Explain briefly; do not change the email.',false);if(await body()!==before)throw new Error('Question changed the canvas');
 await Promise.all([page.waitForResponse(r=>r.url().includes('/account/data/templates') && ['POST','PUT'].includes(r.request().method())),page.getByRole('button',{name:'Save',exact:true}).click()]);await page.waitForURL(url=>url.searchParams.has('id'));await page.reload();await page.locator('.gjs-frame').waitFor();await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();await page.getByRole('log').getByText('Why did you choose this layout? Explain briefly; do not change the email.',{exact:true}).waitFor();if(!((await body()).includes('CEDAR-482 preview')))throw new Error('Saved email lost supplied content');
 await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-editor-conversation.png',fullPage:true});if(errors.length)throw new Error('Browser runtime error');console.log(JSON.stringify({check:'editor follow-up, question, save and restored history',status:'passed'}));
}finally{
 await browser?.close();if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();if(user)await db.deleteFrom('users').where('id','=',user.id).execute();await closeQueues();await closeRedis().catch(()=>{});await closeDb();
}
