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
 console.log('Synthetic workspace created');const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const auth=await fetch('http://localhost:8080/api/auth/me',{headers:{Authorization:`Bearer ${session.token}`}});if(!auth.ok)throw new Error('Local QA session was not accepted; use the running API human-session pepper.');
 console.log('Local authentication accepted');browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const context=await browser.newContext({viewport:{width:1440,height:1080}});
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 const page=await context.newPage();page.setDefaultTimeout(120000);page.on('dialog',dialog=>dialog.accept());
 const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.log('Browser error:',error.message);});
 console.log('Opening dashboard');await page.goto('http://localhost:8080/');
 async function open(){await page.getByTitle('Ask Valasys AI (\u2318J)',{exact:true}).click();await page.getByPlaceholder(/Ask about your sends/).waitFor();}
 await open();console.log('Drawer opened');
 async function ask(text,expected){
  await page.getByPlaceholder(/Ask about your sends/).fill(text);
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByTitle('Send',{exact:true}).click()]);
  await page.waitForFunction(()=>document.body.innerText.includes('Worked for'));
  const href=await page.getByRole('link',{name:/Full page/}).getAttribute('href'),id=new URL(href,'http://localhost:8080').searchParams.get('chat');
  // Wait for the durable result, then verify the actual rendered answer too.
  let last;for(let n=0;n<150;n++){last=(await shared.getAiChat(customer.id,user.id,id)).messages.at(-1);if(!['queued','running'].includes(last.status))break;await new Promise(r=>setTimeout(r,1000));}
  if(last.status!=='completed' || !expected.test(last.text))throw new Error('Drawer answer failed quality check');
  await page.getByText(last.text,{exact:true}).waitFor();console.log(JSON.stringify({check:text,status:'passed'}));return {id,last};
 }
 const first=await ask("how many domain's I have connected?",/23/);
 await page.reload();await open();await page.getByText(first.last.text,{exact:true}).waitFor();
 await ask('and how many are verified?',/\b0\b|none|no domains/i);
 const full=page.getByRole('link',{name:/Full page/});if(!(await full.getAttribute('href')).includes(first.id))throw new Error('Full page lost conversation');
 await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-dashboard-drawer.png',fullPage:true});
 await full.click();await page.waitForURL('**/ai-agent?chat=*');await page.getByText(first.last.text,{exact:true}).waitFor();
 await page.goto('http://localhost:8080/');await open();await page.getByRole('button',{name:'New chat',exact:true}).click();
 if((await page.getByRole('link',{name:/Full page/}).getAttribute('href'))!=='/ai-agent')throw new Error('New chat did not reset conversation');
 if(errors.length)throw new Error('Drawer browser runtime error');console.log(JSON.stringify({check:'refresh history, follow-up, full-page handoff and new chat',status:'passed'}));
}finally{
 await browser?.close();if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();if(user)await db.deleteFrom('users').where('id','=',user.id).execute();await closeQueues();await closeRedis().catch(()=>{});await closeDb();
}
