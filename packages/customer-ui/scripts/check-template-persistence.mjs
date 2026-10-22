import assert from 'node:assert/strict';
import { chromium, request } from '@playwright/test';
const origin=process.env.CUSTOMER_UI_ORIGIN || 'http://127.0.0.1:5173';
const email=process.env.CUSTOMER_UI_TEST_EMAIL,password=process.env.CUSTOMER_UI_TEST_PASSWORD;
if(!email || !password)throw new Error('Set CUSTOMER_UI_TEST_EMAIL and CUSTOMER_UI_TEST_PASSWORD.');
const anonymous=await request.newContext({baseURL:origin});
const login=await anonymous.post('/api/auth/login',{data:{email,password}});
assert.equal(login.status(),200,'Customer login');
const {token}=await login.json();
const api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
let templateId;
let activePage;
try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(value=>sessionStorage.setItem('valasys.session',value),token);
  const page=await context.newPage();activePage=page;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/email-builder`);
  await page.locator('.gjs-frame').waitFor({timeout:30000});
  await page.getByRole('button',{name:'Save',exact:true}).waitFor();
  const name=`Editor persistence ${Date.now()}`;
  await page.locator('header input').fill(name);
  const inputs=page.locator('input');
  // The reference toolbar order is name, sender, subject, preview text.
  await inputs.nth(2).fill('Server saved revision one');
  const created=page.waitForResponse(response=>response.url().endsWith('/api/account/data/templates') && response.request().method()==='POST');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  const first=await created;assert.equal(first.status(),201,await first.text());
  const firstBody=await first.json();templateId=firstBody.id;
  assert.equal(firstBody.revision,1);
  await page.getByText('Version saved',{exact:true}).waitFor();
  const stored=await api.get(`/api/account/data/templates/${templateId}`);
  const document=await stored.json();
  assert.equal(document.subject,'Server saved revision one');
  assert.ok(document.editor_document.project,'GrapesJS project is persisted');
  assert.ok(document.html_body.includes('Add your email content here.'),'Rendered HTML is persisted');
  await page.reload();
  await page.locator('.gjs-frame').waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='Server saved revision one'));
  const other=await context.newPage();activePage=other;other.on('pageerror',error=>errors.push(error.message));await other.goto(`${origin}/email-builder?id=${templateId}`);
  await other.locator('.gjs-frame').waitFor();
  await other.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='Server saved revision one'));
  await page.locator('input').nth(2).fill('Server saved revision two');
  const updated=page.waitForResponse(response=>response.url().endsWith(`/api/account/data/templates/${templateId}`) && response.request().method()==='PUT');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  const second=await updated;assert.equal(second.status(),200,await second.text());assert.equal((await second.json()).revision,2);
  await other.locator('input').nth(2).fill('Conflicting stale edit');
  const conflict=other.waitForResponse(response=>response.url().endsWith(`/api/account/data/templates/${templateId}`) && response.request().method()==='PUT');
  await other.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await conflict).status(),409,'Stale editor cannot overwrite a newer save');
  await other.getByText('This template was saved in another session. Reload before saving again.',{exact:true}).waitFor();
  const history=await api.get(`/api/account/data/templates/${templateId}/versions`);
  assert.deepEqual((await history.json()).versions.map(v=>v.revision),[2,1]);
  const old=await api.get(`/api/account/data/templates/${templateId}/versions/1`);
  assert.equal((await old.json()).subject,'Server saved revision one');
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByText('Server saved revision one',{exact:true}).first().waitFor();
  await page.getByRole('button',{name:'Restore',exact:true}).last().click();
  await page.getByText('Version restored to the editor. Save to create a new version.',{exact:true}).waitFor();
  await page.frameLocator('.gjs-frame').getByText('Add your email content here.',{exact:true}).waitFor();
  assert.equal(await page.locator('input').nth(2).inputValue(),'Server saved revision one');
  const restored=page.waitForResponse(response=>response.url().endsWith(`/api/account/data/templates/${templateId}`) && response.request().method()==='PUT');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await (await restored).json()).revision,3,'Restoring creates a new revision, not a rewrite of history');
  assert.deepEqual(errors,[]);
  console.log('PASS editor save, reload, project persistence, history, and stale-write protection');
  await context.close();
}catch(error){
  if(activePage){console.error('Editor diagnostic:',await activePage.locator('body').innerText());await activePage.screenshot({path:'packages/customer-ui/test-results/template-failure.png'});}
  throw error;
}finally{
  if(templateId){const removed=await api.delete(`/api/account/data/templates/${templateId}`);assert.equal(removed.status(),204,'Remove the temporary test template');}
  await browser.close();await api.post('/api/auth/logout',{data:{}});await api.dispose();await anonymous.dispose();
}
