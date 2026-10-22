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
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const auth=await fetch('http://localhost:8080/api/auth/me',{headers:{Authorization:`Bearer ${session.token}`}});if(!auth.ok)throw new Error('Local QA session was not accepted; use the running API human-session pepper.');
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const context=await browser.newContext({viewport:{width:1440,height:1080}});
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 const page=await context.newPage();page.setDefaultTimeout(120000);page.on('dialog',dialog=>dialog.accept());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // The workspace deliberately has no audience, templates or sending domains.
 await page.goto('http://localhost:8080/workflow-builder');
 await page.getByText('New unsaved draft').or(page.getByText('Saved to workspace')).first().waitFor();
 await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();
 async function ask(text){
  await page.getByLabel('Message the AI assistant').fill(text);
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/turns') && r.status()===202),page.getByRole('button',{name:'Send message',exact:true}).click()]);
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden',timeout:300000});
  const chatId=new URL(page.url()).searchParams.get('ai_chat'),saved=await shared.getAiChat(customer.id,user.id,chatId),last=saved.messages.at(-1);
  if(last.status!=='completed' || last.result?.operation!=='workflow'){
   console.log(JSON.stringify({check:text,status:last.status,operation:last.result?.operation,error:last.error,reply:(last.text||'').slice(0,600)}));throw new Error('Live workflow generation did not produce an edited workflow');
  }
  await page.getByText('Saved to workspace').waitFor();
  console.log(JSON.stringify({check:text,status:'passed',nodes:last.result.document.graph.nodes.length}));return {chatId,result:last.result};
 }
 const first=await ask('create workflow for not active leads to relogin');
 if(first.result.document.graph.nodes.length<2 || !first.result.document.graph.nodes.some(n=>n.t==='email') || !first.result.document.graph.edges.length)throw new Error('AI did not build a connected journey');
 const second=await ask('Add a 2-day wait and another follow-up email after the current email. Keep the existing workflow and its steps. We have no audience yet; leave templates empty where needed.');
 const before=first.result.document.graph.nodes.map(n=>n.id),after=second.result.document.graph.nodes.map(n=>n.id);
 if(!before.every(id=>after.includes(id)) || after.length<before.length+2)throw new Error('Follow-up did not preserve and extend the existing workflow');
 const id=new URL(page.url()).searchParams.get('id');if(!id)throw new Error('Workflow was not autosaved');
 await page.reload();await page.getByText('Saved to workspace').waitFor();await page.getByRole('button',{name:'\u2726 AI',exact:true}).click();
 await page.locator('[data-editor-ai-conversation]').getByText('create workflow for not active leads to relogin',{exact:true}).waitFor();
 await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
 await mkdir('packages/customer-ui/test-results/ai-live',{recursive:true});await page.screenshot({path:'packages/customer-ui/test-results/ai-live/live-workflow-reliability.png',fullPage:true});
 await page.goto('http://localhost:8080/ai-agent');await page.getByPlaceholder(/Ask anything/).waitFor();
 if(new URL(page.url()).searchParams.has('chat') || await page.getByText('create workflow for not active leads to relogin',{exact:true}).count())throw new Error('Workflow conversation appeared in main chat');
 await page.goto(`http://localhost:8080/ai-agent?chat=${second.chatId}`);await page.waitForURL('**/workflow-builder?*');
 if(new URL(page.url()).searchParams.get('id')!==id)throw new Error('Builder conversation opened the wrong workflow');
 if(errors.length)throw new Error('Browser runtime error');console.log(JSON.stringify({check:'history reload, separate main chat and builder-link redirect',status:'passed'}));
}finally{
 await browser?.close();if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();if(user)await db.deleteFrom('users').where('id','=',user.id).execute();await closeQueues();await closeRedis().catch(()=>{});await closeDb();
}
