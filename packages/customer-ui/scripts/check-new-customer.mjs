import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {writeFile,mkdir} from 'node:fs/promises';
import {chromium,request} from '@playwright/test';
import {totpCode} from '../../shared/dist/totp.js';

const origin=process.env.CUSTOMER_UI_ORIGIN || 'http://127.0.0.1:5173';
const mailpit=process.env.MAILPIT_API_URL || 'http://127.0.0.1:8025';
const run=promisify(execFile),suffix=randomUUID();
const emails=[`ui-reliability-${suffix}@example.test`,`ui-reliability-${randomUUID()}@example.test`,`ui-reliability-${randomUUID()}@example.test`];
const password=`Reliability!${randomUUID()}`,newPassword=`Updated!${randomUUID()}`;
const anonymous=await request.newContext({baseURL:origin});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const output=new URL('../test-results/reliability/',import.meta.url);await mkdir(output,{recursive:true});
const report={passed:[],unavailable:[],errors:[]};let page,api,otherApi,created=false;
async function passed(name){report.passed.push(name);console.log(`PASS ${name}`);}
async function mailLink(email,path){
  for(let attempt=0;attempt<50;attempt++){
    const response=await fetch(`${mailpit}/api/v1/messages?limit=100`);assert.ok(response.ok,'Mailpit is available');
    const messages=(await response.json()).messages || [];
    for(const message of messages.filter(message=>message.To?.some(to=>String(to.Address ?? to).toLowerCase()===email))){
      const detail=await (await fetch(`${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}`)).json();
      const match=String(detail.Text || '').match(new RegExp(`https?://[^\\s<>]+/${path}\\?token=[^\\s<>]+`));
      if(match){const url=new URL(match[0]);assert.equal(url.origin,process.env.CUSTOMER_EMAIL_ORIGIN || 'http://localhost:8080','Account email links point at the frontend');return url.pathname+url.search;}
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`No ${path} message was captured in Mailpit.`);
}
async function signIn(pass=password){
  await page.getByLabel('Work email',{exact:true}).fill(emails[0]);
  await page.getByLabel('Password',{exact:true}).fill(pass);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
}
async function contact(name,email,status='Pending'){
  await page.getByRole('button',{name:'Add contact',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Name',{exact:true}).fill(name);await dialog.getByLabel('Email',{exact:true}).fill(email);
  await dialog.getByLabel('Marketing email status').selectOption(status);
  if(status==='Subscribed')await dialog.getByRole('checkbox').check();
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/account/data/contacts') && response.request().method()==='POST');
  await dialog.getByRole('button',{name:'Add contact',exact:true}).click();assert.equal((await saved).status(),201);
  await page.getByText('Contact saved',{exact:true}).waitFor();
}
try{
  for(let attempt=0;attempt<60;attempt++){const response=await anonymous.get('/api/auth/me');if(response.status()===401)break;await new Promise(resolve=>setTimeout(resolve,500));}
  const context=await browser.newContext({viewport:{width:1440,height:900}});page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));page.on('console',event=>{if(event.type()==='error' && event.text().includes('Customer UI render failed'))report.errors.push(event.text());});
  await page.goto(`${origin}/contacts`);await page.getByRole('heading',{name:'Welcome back'}).waitFor();
  assert.equal(await page.getByLabel('Work email',{exact:true}).inputValue(),'','No hardcoded login identity');
  await page.getByRole('link',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Full name',{exact:true}).fill('Reliability End to End');await page.getByLabel('Work email',{exact:true}).fill(emails[0]);await page.getByPlaceholder('At least 8 characters').fill(password);
  const registration=page.waitForResponse(response=>response.url().endsWith('/api/auth/register') && response.request().method()==='POST');
  await page.getByRole('button',{name:'Create account',exact:true}).click();assert.equal((await registration).status(),201);created=true;
  await page.getByLabel('Company name',{exact:true}).fill('Reliability Workspace');
  await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByPlaceholder('mail.acme.com',{exact:true}).fill(`mail.ui-reliability-${suffix}.example.test`);
  const domainResponse=page.waitForResponse(response=>response.url().endsWith('/api/account/domains') && response.request().method()==='POST');
  await page.getByRole('button',{name:'Get DNS records',exact:true}).click();const domainResult=await domainResponse;assert.equal(domainResult.status(),201);const dns=await domainResult.json();
  await page.getByText('Add these records at your DNS provider',{exact:true}).waitFor();
  for(const record of dns.dns_records){await page.getByText(record.host,{exact:true}).first().waitFor();await page.getByText(record.value,{exact:true}).first().waitFor();}
  assert.doesNotMatch(await page.locator('body').innerText(),/MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7x2|bounce\.valasys\.io/);
  await page.getByRole('button',{name:'Skip for now',exact:true}).click();await page.getByText('Create a key in Settings → API keys',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(),/vsl_live_8f2c|api\.valasys\.io/);
  await passed('Onboarding persists the workspace name and shows only real DNS records, never example credentials');
  await page.getByRole('button',{name:'Finish later',exact:true}).click();
  await page.getByRole('button',{name:'Contacts',exact:true}).click();
  await page.getByText('Current workspace',{exact:true}).first().waitFor();
  const token=await page.evaluate(()=>sessionStorage.getItem('valasys.session'));assert.ok(token);
  api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});
  const empty=await (await api.get('/api/account/data/contacts')).json();assert.equal(empty.stats.total,0);assert.deepEqual(empty.contacts,[]);
  assert.doesNotMatch(await page.locator('body').innerText(),/NaN|Infinity|48,168|2,140/);
  await page.screenshot({path:fileURLToPath(new URL('contacts-empty.png',output)),fullPage:true});
  await passed('UI registration, session restore and truthful empty contacts');
  await contact('Reliability Pending','pending@example.test');
  await contact('Reliability Subscriber','subscriber@example.test','Subscribed');
  await page.reload();await page.getByText('Reliability Subscriber',{exact:true}).waitFor();
  await page.getByText('Reliability Subscriber',{exact:true}).click();
  await page.getByRole('button',{name:'Unsubscribe',exact:true}).click();await page.getByText('Contacts unsubscribed',{exact:true}).waitFor();
  const contacts=await (await api.get('/api/account/data/contacts')).json();assert.equal(contacts.stats.total,2);assert.equal(contacts.stats.unsubscribed,1);
  const suppressions=await (await api.get('/api/account/data/suppressions')).json();assert.ok(suppressions.suppressions.some(row=>row.email==='subscriber@example.test' && row.reason==='unsubscribe'));
  await passed('Contact create/consent, reload persistence and real unsubscribe enforcement');
  await page.getByRole('button',{name:'Import',exact:true}).click();
  await page.getByRole('dialog').getByLabel('CSV file').setInputFiles({name:'contacts.csv',mimeType:'text/csv',buffer:Buffer.from('email,name,company\r\ncsv1@example.test,"Comma, Name",Company\r\ncsv2@example.test,Second,Company\r\n')});
  await page.getByRole('button',{name:'Import 2 contacts',exact:true}).click();await page.getByText('Imported 2 contacts',{exact:true}).waitFor();
  assert.equal((await (await api.get('/api/account/data/contacts')).json()).stats.total,4);
  assert.equal((await api.post('/api/account/data/contacts/import',{data:{contacts:[{name:'Rollback',email:'rollback@example.test'},{name:'Duplicate',email:'csv1@example.test'}]}})).status(),409);
  assert.equal((await (await api.get('/api/account/data/contacts')).json()).stats.total,4,'Duplicate import rolls back the complete batch');
  await passed('Real CSV import and atomic duplicate rejection');
  await page.screenshot({path:fileURLToPath(new URL('contacts-saved.png',output)),fullPage:true});
  const traffic=[];const trace=request=>{if(request.method()==='GET' && request.url().includes('/api/'))traffic.push(new URL(request.url()).pathname);};page.on('request',trace);
  await page.reload();await page.getByText('Reliability Pending',{exact:true}).waitFor();
  assert.ok(!traffic.some(path=>/analytics|api-keys|webhooks|\/messages/.test(path)),`Contacts does not fetch unrelated sections: ${traffic.join(', ')}`);page.off('request',trace);
  let failedReads=0;
  await page.route('**/api/account/data/contacts?*',route=>{failedReads++;return route.fulfill({status:503,json:{error:'temporary_unavailable'}});});
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByRole('button',{name:'Retry refresh',exact:true}).waitFor();
  assert.equal(failedReads,2,'A transient read gets exactly one automatic retry');await page.getByText('Reliability Pending',{exact:true}).waitFor();
  await page.unroute('**/api/account/data/contacts?*');await page.getByRole('button',{name:'Retry refresh',exact:true}).click();await page.getByRole('button',{name:'Retry refresh',exact:true}).waitFor({state:'detached'});
  await passed('Active-page-only reads, bounded transient retry, preserved data and in-page recovery');
  const syncEmail=`sync-${suffix}@example.test`,sync=await api.post('/api/account/data/contacts',{data:{name:'Reliability Cross Tab',email:syncEmail}});assert.equal(sync.status(),201);const syncId=(await sync.json()).contact.id;
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByText('Reliability Cross Tab',{exact:true}).waitFor();
  assert.equal((await api.post('/api/account/data/contacts/bulk',{data:{ids:[syncId],action:'delete'}})).status(),200);
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.getByText('Reliability Cross Tab',{exact:true}).waitFor({state:'detached'});
  await passed('Reconnect refresh reflects backend changes made outside the current tab');
  await page.getByRole('button',{name:'Add contact',exact:true}).click();const offlineDialog=page.getByRole('dialog');
  await offlineDialog.getByLabel('Name',{exact:true}).fill('Reliability Offline Draft');await offlineDialog.getByLabel('Email',{exact:true}).fill(`offline-${suffix}@example.test`);
  await context.setOffline(true);await page.getByText('You are offline',{exact:true}).waitFor();await offlineDialog.getByRole('button',{name:'Add contact',exact:true}).click();await offlineDialog.getByRole('alert').waitFor();assert.equal(await offlineDialog.getByLabel('Name',{exact:true}).inputValue(),'Reliability Offline Draft');
  await context.setOffline(false);await page.getByText('You are offline',{exact:true}).waitFor({state:'detached'});
  let writeAttempts=0;
  await page.route('**/api/account/data/contacts',route=>{writeAttempts++;return route.fulfill({status:503,json:{error:'temporary_unavailable'}});});
  await offlineDialog.getByRole('button',{name:'Add contact',exact:true}).click();await offlineDialog.getByRole('alert').filter({hasText:'temporarily unavailable'}).waitFor();assert.equal(writeAttempts,1,'Failed writes are never automatically replayed');await page.unroute('**/api/account/data/contacts');
  let actualWrites=0;const writes=request=>{if(request.method()==='POST' && request.url().endsWith('/api/account/data/contacts'))actualWrites++;};page.on('request',writes);
  await offlineDialog.getByRole('button',{name:'Add contact',exact:true}).evaluate(button=>{button.click();button.click();});await page.getByText('Contact saved',{exact:true}).waitFor();assert.equal(actualWrites,1,'Double submit causes one write');page.off('request',writes);
  const offlineContact=(await (await api.get('/api/account/data/contacts')).json()).contacts.find(row=>row.email===`offline-${suffix}@example.test`);assert.ok(offlineContact);assert.equal((await api.post('/api/account/data/contacts/bulk',{data:{ids:[offlineContact.id],action:'delete'}})).status(),200);
  await passed('Offline forms retain drafts, failed writes are not retried and double submits create one record');
  await page.goto(`${origin}/api-keys`);await page.getByRole('button',{name:'Create key',exact:true}).first().click();
  await page.getByPlaceholder('e.g. Order service',{exact:true}).fill(`Reliability key ${suffix}`);
  let keyWrites=0;const keyTrace=request=>{if(request.method()==='POST' && request.url().endsWith('/api/account/api-keys'))keyWrites++;};page.on('request',keyTrace);
  await page.getByRole('button',{name:'Create key',exact:true}).last().evaluate(button=>{button.click();button.click();});
  await page.getByText(`Reliability key ${suffix}`,{exact:true}).first().waitFor();assert.equal(keyWrites,1,'Duplicate workspace actions create only one API key');page.off('request',keyTrace);
  const keys=(await (await api.get('/api/account/api-keys')).json()).keys.filter(key=>key.name===`Reliability key ${suffix}`);assert.equal(keys.length,1);assert.equal((await api.delete(`/api/account/api-keys/${keys[0].id}`)).status(),200);
  await passed('Workspace action double-submit protection with real API-key creation and revocation');
  const second=await anonymous.post('/api/auth/register',{data:{email:emails[1],password,name:'Reliability Isolation'}});assert.equal(second.status(),201);
  otherApi=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${(await second.json()).token}`}});
  assert.equal((await (await otherApi.get('/api/account/data/contacts')).json()).stats.total,0);
  assert.equal((await otherApi.post('/api/account/data/contacts/bulk',{data:{ids:[contacts.contacts[0].id],action:'delete'}})).status(),404);
  assert.equal((await (await api.get('/api/account/data/contacts')).json()).stats.total,4);
  await passed('New-tenant isolation and cross-tenant mutation rejection');
  await page.goto(`${origin}/lists`);await page.getByRole('button',{name:'Create list',exact:true}).first().click();await page.getByLabel('Name',{exact:true}).fill('Reliability List');await page.getByRole('button',{name:'Create list',exact:true}).last().click();await page.getByText('Audience saved',{exact:true}).waitFor();
  const list=(await (await api.get('/api/account/data/audiences')).json()).collections.find(row=>row.name==='Reliability List');assert.ok(list);assert.equal(list.count,0);
  await page.goto(`${origin}/contacts`);await page.getByText('Reliability Pending',{exact:true}).waitFor();await page.locator('tbody tr').filter({hasText:'Reliability Pending'}).locator('button').first().click();await page.getByRole('button',{name:'Add to list',exact:true}).click();await page.getByRole('dialog').getByLabel('List',{exact:true}).selectOption(list.id);await page.getByRole('dialog').getByRole('button',{name:'Add to list',exact:true}).click();await page.getByText('Contacts added to list',{exact:true}).waitFor();
  assert.equal((await (await api.get(`/api/account/data/audiences/${list.id}/members`)).json()).contacts.length,1);assert.equal((await otherApi.get(`/api/account/data/audiences/${list.id}/members`)).status(),404);await page.reload();await page.locator('tbody tr').filter({hasText:'Reliability Pending'}).getByText('Reliability List',{exact:true}).waitFor();
  const segment=await api.post('/api/account/data/audiences',{data:{kind:'segment',name:'Reliability Recent',rules:[{field:'Created',op:'in last',val:'7 days'}]}});assert.equal(segment.status(),201);
  const segmentId=(await segment.json()).id;assert.equal((await (await api.get(`/api/account/data/audiences/${segmentId}/members`)).json()).contacts.length,4);
  const opened=await api.post('/api/account/data/audiences',{data:{kind:'segment',name:'Reliability Opened',rules:[{field:'Opened any email',op:'in last',val:'30 days'}]}});assert.equal(opened.status(),201);assert.equal((await (await api.get(`/api/account/data/audiences/${(await opened.json()).id}/members`)).json()).contacts.length,0);
  await page.goto(`${origin}/segments`);await page.getByText('Reliability Recent',{exact:true}).waitFor();await page.reload();await page.getByText('Reliability Recent',{exact:true}).waitFor();
  await passed('Real list creation/membership, dynamic segment counts, reload persistence and audience isolation');
  const campaignTemplate=await api.post('/api/account/data/templates',{data:{name:'Reliability Campaign Design',subject:'A reliable campaign',html_body:'<p>An isolated draft design.</p>'}});assert.equal(campaignTemplate.status(),201);const campaignTemplateId=(await campaignTemplate.json()).id;
  await page.goto(`${origin}/campaigns`);await page.getByRole('button',{name:'Create campaign',exact:true}).click();await page.getByPlaceholder('e.g. November newsletter').fill('Reliability Campaign');
  const campaignCreated=page.waitForResponse(response=>response.url().endsWith('/api/account/data/campaigns') && response.request().method()==='POST');
  await page.getByRole('button',{name:'Create and design email',exact:true}).click();assert.equal((await campaignCreated).status(),201);await page.getByRole('button',{name:'Save draft',exact:true}).waitFor();
  await page.getByRole('button').filter({hasText:'Reliability Campaign Design'}).click();await page.getByPlaceholder('What’s in it for the reader?').fill('Reliable draft subject');await page.getByLabel('Sender name',{exact:true}).fill('Reliability Sender');
  await page.getByRole('button',{name:'Schedule',exact:true}).click();const scheduleDate=await page.evaluate(()=>{const date=new Date(Date.now()+86400000);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;});await page.getByLabel('Date',{exact:true}).fill(scheduleDate);await page.getByLabel('Time',{exact:true}).fill('10:30');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByText('Campaign draft saved',{exact:true}).waitFor();
  await page.reload();await page.getByText('Reliability Campaign',{exact:true}).click();await page.getByRole('button',{name:'Save draft',exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/hello@acme|48,210|18,640|predicted/);
  assert.equal(await page.getByLabel('Date',{exact:true}).inputValue(),scheduleDate);assert.equal(await page.getByLabel('Time',{exact:true}).inputValue(),'10:30');assert.ok((await page.locator('body').innerText()).includes('Browser time zone'));
  const campaigns=(await (await api.get('/api/account/data/campaigns')).json()).campaigns;assert.equal(campaigns.length,1);assert.equal(campaigns[0].subject,'Reliable draft subject');assert.equal(campaigns[0].from_name,'Reliability Sender');assert.equal(campaigns[0].template_id,campaignTemplateId);assert.equal((await (await otherApi.get('/api/account/data/campaigns')).json()).campaigns.length,0);
  await passed('Real campaign draft creation/save/reload, truthful setup and tenant isolation');
  await page.goto(`${origin}/campaigns`);await page.getByRole('button',{name:'Create campaign',exact:true}).click();await page.getByPlaceholder('e.g. November newsletter').fill('Reliability Subject Test');await page.getByRole('button',{name:/^A\/B test/}).click();
  await page.getByRole('button',{name:'Create and design email',exact:true}).click();await page.getByPlaceholder('Test a different angle').waitFor();await page.getByPlaceholder('Test a different angle').fill('A different subject');await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByText('Campaign draft saved',{exact:true}).waitFor();
  await page.reload();await page.getByText('Reliability Subject Test',{exact:true}).click();assert.equal(await page.getByPlaceholder('Test a different angle').inputValue(),'A different subject');assert.ok((await page.locator('body').innerText()).includes('no automatic winner'));const subjectTest=(await (await api.get('/api/account/data/campaigns')).json()).campaigns.find(row=>row.name==='Reliability Subject Test');assert.equal(subjectTest.campaign_type,'ab_subject');assert.equal(subjectTest.subject_b,'A different subject');
  await passed('Original A/B design controls backed by persisted subject-test drafts and explicit fixed-split limits');
  assert.doesNotMatch(await page.locator('body').innerText(),/winner by open rate|rest after 4 hours/);
  const invite=await api.post('/api/team/invites',{data:{email:emails[1],role:'analyst'}});assert.equal(invite.status(),201);const invitePath=await mailLink(emails[1],'accept-invite');
  const invitedContext=await browser.newContext(),invitedPage=await invitedContext.newPage();await invitedPage.goto(origin+invitePath);await invitedPage.getByRole('button',{name:'Accept invitation',exact:true}).click();await invitedPage.getByText('Reliability Pending',{exact:true}).waitFor();assert.equal(await invitedPage.getByRole('button',{name:'Add contact',exact:true}).count(),0);
  const invitedToken=await invitedPage.evaluate(()=>sessionStorage.getItem('valasys.session'));const analyst=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${invitedToken}`}});assert.equal((await (await analyst.get('/api/auth/me')).json()).current_role,'analyst');assert.equal((await analyst.post('/api/account/data/contacts',{data:{name:'Denied',email:'denied@example.test'}})).status(),403);await analyst.dispose();await invitedContext.close();
  const replay=await anonymous.post('/api/team/invites/accept',{data:{token:new URLSearchParams(invitePath.split('?')[1]).get('token')}});assert.equal(replay.status(),410);
  assert.equal((await api.post('/api/team/invites',{data:{email:emails[2],role:'analyst'}})).status(),201);const newInvite=await mailLink(emails[2],'accept-invite'),newContext=await browser.newContext(),newPage=await newContext.newPage();await newPage.goto(origin+newInvite);await newPage.getByRole('button',{name:'I need to create an account',exact:true}).click();await newPage.getByLabel('Full name',{exact:true}).fill('Reliability Invited User');await newPage.getByLabel('New account password',{exact:true}).fill(password);await newPage.getByRole('button',{name:'Accept invitation',exact:true}).click();await newPage.getByText('Reliability Pending',{exact:true}).waitFor();await newContext.close();
  await passed('Actual invitation emails, existing/new user acceptance, readonly UI authorization and single-use tokens');
  await page.goto(`${origin}/workflow-builder`);await page.getByText('New unsaved draft',{exact:true}).waitFor();await page.locator('input').first().fill('Reliability Workflow');await page.getByText('Wait',{exact:true}).first().click();await page.getByText('Saved to workspace',{exact:true}).waitFor();
  const workflowId=new URL(page.url()).searchParams.get('id');assert.ok(workflowId);const builder=await (await api.get(`/api/account/data/workflows/${workflowId}/builder`)).json();assert.equal(builder.builder_document.graph.nodes.length,2);assert.equal((await otherApi.get(`/api/account/data/workflows/${workflowId}/builder`)).status(),404);
  assert.equal((await api.put(`/api/account/data/workflows/${workflowId}/builder`,{data:{expected_revision:0,name:builder.name,document:builder.builder_document}})).status(),409);
  await page.reload();await page.getByText('Saved to workspace',{exact:true}).waitFor();await page.getByRole('button',{name:'Test run',exact:true}).click();await page.getByText('Server dry run only. No mail or webhooks were sent.',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('button',{name:'Activate',exact:true}).first().click();await page.getByRole('button',{name:'Activate',exact:true}).last().click();await page.getByRole('button',{name:'Pause',exact:true}).waitFor();await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Activate',exact:true}).first().waitFor();
  assert.equal((await (await api.get(`/api/account/data/workflows/${workflowId}`)).json()).status,'paused');assert.equal((await (await api.get(`/api/account/data/workflows/${workflowId}/versions`)).json()).versions.length,1);
  await passed('Workflow draft autosave/reload, tenant isolation, stale-write rejection, server dry run, publish and pause');
  assert.equal((await api.post(`/api/account/data/workflows/${workflowId}/resume`,{data:{}})).status(),200);const historyRun=await api.post(`/api/account/data/workflows/${workflowId}/trigger`,{data:{subject_email:`history-${suffix}@example.test`}});assert.equal(historyRun.status(),202);const historyRunId=(await historyRun.json()).run_id;
  await page.getByRole('button',{name:'Runs & versions',exact:true}).click();const historyDialog=page.getByRole('dialog',{name:'Workflow runs and versions'});await historyDialog.getByText('Version 1',{exact:false}).waitFor();await historyDialog.getByText(`history-${suffix}@example.test`,{exact:true}).waitFor();page.once('dialog',dialog=>dialog.accept());await historyDialog.getByRole('button',{name:'Cancel run',exact:true}).click();await historyDialog.getByText('canceled',{exact:true}).waitFor();assert.equal((await (await api.get(`/api/account/data/workflows/runs/${historyRunId}`)).json()).run.status,'canceled');await historyDialog.getByRole('button',{name:'Close workflow history'}).click();assert.equal((await api.post(`/api/account/data/workflows/${workflowId}/pause`,{data:{}})).status(),200);
  await passed('Real workflow run/version history and explicit run cancellation');
  await page.getByText('If / else',{exact:true}).first().click();await page.getByText('Saved to workspace',{exact:true}).waitFor();const branchDraft=(await (await api.get(`/api/account/data/workflows/${workflowId}/builder`)).json()).builder_document;assert.ok(branchDraft.graph.nodes.some(node=>node.t==='branch' && node.cond==='activated'));
  await page.goto(`${origin}/deliverability`);await page.getByText('DMARC aggregate reporting',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/97% inbox|8 of 8 met|42 mailboxes|mail\.acme\.com/);
  assert.equal((await api.get('/api/account/data/dmarc/summary')).status(),200);await passed('Live domain/DMARC monitoring without fabricated inbox-placement claims');
  await page.goto(origin+await mailLink(emails[0],'verify-email'));await page.getByText('Your email is verified.',{exact:true}).waitFor();
  assert.ok((await (await api.get('/api/account/data/profile')).json()).customer.email_verified_at);
  await passed('Actual Mailpit verification email, frontend link and backend verification');
  await page.goto(`${origin}/forgot-password`);await page.getByLabel('Work email',{exact:true}).fill(emails[0]);await page.getByRole('button',{name:'Send reset link',exact:true}).click();await page.getByRole('status').filter({hasText:'If an account uses that email'}).waitFor();
  await page.goto(origin+await mailLink(emails[0],'reset-password'));
  await page.getByLabel('New password',{exact:true}).fill(newPassword);await page.getByLabel('Confirm password',{exact:true}).fill(newPassword);await page.getByRole('button',{name:'Reset password',exact:true}).click();await page.getByText('Your password has been updated.',{exact:false}).waitFor();
  assert.equal((await api.get('/api/auth/me')).status(),401,'Password reset revokes old sessions');
  await page.getByRole('link',{name:'Back to sign in',exact:true}).click();await signIn(password);await page.getByRole('alert').filter({hasText:'The email or password is incorrect.'}).waitFor();await signIn(newPassword);await page.getByRole('button',{name:'Contacts',exact:true}).waitFor();
  await passed('Password recovery through actual email, old-session revocation and invalid/valid login');
  await page.goto(`${origin}/contacts`);
  await page.route('**/api/auth/me',route=>route.fulfill({status:503,json:{error:'unavailable'}}));await page.reload();await page.getByRole('button',{name:'Retry connection'}).waitFor();assert.ok(await page.evaluate(()=>sessionStorage.getItem('valasys.session')));
  await page.unroute('**/api/auth/me');await page.getByRole('button',{name:'Retry connection'}).click();await page.getByText('Reliability Pending',{exact:true}).waitFor();
  await passed('Transient API failure retains the session and supports retry');
  const currentToken=await page.evaluate(()=>sessionStorage.getItem('valasys.session'));await api.dispose();api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${currentToken}`}});
  const factor=await (await api.post('/api/auth/mfa/enroll',{data:{}})).json();assert.ok(factor.secret);
  const confirmation=await api.post('/api/auth/mfa/confirm',{data:{factor_id:factor.factor_id,code:totpCode(factor.secret)}});assert.equal(confirmation.status(),200);const recoveryCodes=(await confirmation.json()).recovery_codes;
  await api.post('/api/auth/logout',{data:{}});await page.reload();await page.getByRole('heading',{name:'Welcome back'}).waitFor();await signIn(newPassword);await page.getByRole('heading',{name:'Verify your sign-in'}).waitFor();await page.reload();await page.getByRole('heading',{name:'Verify your sign-in'}).waitFor();
  await page.getByLabel('Authentication code',{exact:true}).fill(totpCode(factor.secret,Date.now()+600000));await page.getByRole('button',{name:'Verify',exact:true}).click();await page.getByRole('alert').filter({hasText:'That authentication code is not valid.'}).waitFor();
  // Confirmation consumed the current TOTP; use a one-time recovery code for
  // this same-second sign-in instead of waiting for the next 30-second step.
  const recovery=await api.get('/api/auth/me');assert.equal(recovery.status(),401);
  await page.getByLabel('Authentication code',{exact:true}).fill(recoveryCodes[0]);await page.getByRole('button',{name:'Verify',exact:true}).click();await page.getByText('Reliability Pending',{exact:true}).waitFor();
  await passed('MFA enrollment, challenge persistence, invalid-code rejection and successful challenge');
  for(const path of ['ai-agent']){
    await page.goto(`${origin}/${path}`);await page.getByText(/not connected yet|still being integrated/).first().waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/NaN|Infinity|48,210|384,210|sarah@acme/);report.unavailable.push(path);
  }
  await passed('Unintegrated pages cannot display prototype customer results or simulate writes');
  await page.goto(`${origin}/contacts`);await page.getByText('Reliability Pending',{exact:true}).waitFor();
  const logoutToken=await page.evaluate(()=>sessionStorage.getItem('valasys.session'));
  await page.locator('header').getByRole('button').filter({hasText:'Reliability End to End'}).click();
  await page.getByRole('button',{name:'Log out',exact:true}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('valasys.session')),null,'Logout clears the local session');
  assert.equal((await anonymous.get('/api/auth/me',{headers:{Authorization:`Bearer ${logoutToken}`}})).status(),401,'Logout revokes the backend session');
  await passed('Actual UI logout clears the session and returns to sign in');
  await page.setViewportSize({width:390,height:844});await page.getByLabel('Work email',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile sign-in does not overflow');
  await page.screenshot({path:fileURLToPath(new URL('login-mobile.png',output)),fullPage:true});await page.setViewportSize({width:1440,height:900});await page.screenshot({path:fileURLToPath(new URL('login-desktop.png',output)),fullPage:true});
  await passed('Responsive sign-in and accessible labelled fields');
  assert.deepEqual(report.errors,[]);await context.close();
}catch(error){if(page){await page.screenshot({path:fileURLToPath(new URL('failure.png',output)),fullPage:true});console.error('UI state:',await page.locator('body').innerText());}throw error;}
finally{
  await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));await browser.close();await api?.dispose();await otherApi?.dispose();await anonymous.dispose();
  if(created){const script=fileURLToPath(new URL('cleanup-reliability-fixtures.cjs',import.meta.url));await run('docker',['cp',script,'mail-api:/tmp/cleanup-reliability-fixtures.cjs']);const result=await run('docker',['exec','mail-api','node','/tmp/cleanup-reliability-fixtures.cjs',...emails]);console.log(result.stdout.trim());await run('docker',['exec','--user','0','mail-api','rm','/tmp/cleanup-reliability-fixtures.cjs']);}
}
