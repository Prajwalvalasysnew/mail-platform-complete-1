import assert from 'node:assert/strict';
import { chromium, request } from '@playwright/test';
const origin=process.env.CUSTOMER_UI_ORIGIN || 'http://127.0.0.1:5173';
const email=process.env.CUSTOMER_UI_TEST_EMAIL,password=process.env.CUSTOMER_UI_TEST_PASSWORD;
if(!email || !password)throw new Error('Set CUSTOMER_UI_TEST_EMAIL and CUSTOMER_UI_TEST_PASSWORD.');
const anonymous=await request.newContext({baseURL:origin});
const response=await anonymous.post('/api/auth/login',{data:{email,password}});
assert.equal(response.status(),200);
const {token}=await response.json();
const api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});
const original=await (await api.get('/api/account/data/profile')).json();
assert.ok(original.customer,'The customer profile endpoint is available');
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const suffix=Date.now();const temporaryName=`Settings check ${suffix}`;
let domainId,page;
try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(value=>sessionStorage.setItem('valasys.session',value),token);
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',event=>{if(event.type()==='error')console.error(event.text());});
  await page.goto(`${origin}/settings`);
  const workspaceInput=page.getByText('Workspace name',{exact:true}).locator('xpath=ancestor::div[input][1]/input');
  await workspaceInput.waitFor();
  await page.waitForFunction(name=>Array.from(document.querySelectorAll('input')).some(input=>input.value===name),original.customer.name);
  await workspaceInput.fill(temporaryName);
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/account/data/profile') && r.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  assert.equal((await saved).status(),200);
  await page.getByText('Workspace settings saved',{exact:true}).waitFor();
  await page.reload();
  await page.waitForFunction(name=>Array.from(document.querySelectorAll('input')).some(input=>input.value===name),temporaryName);
  const unsupported=await api.patch('/api/account/data/profile',{data:{enf2fa:true}});
  assert.equal(unsupported.status(),400,'Unenforced security preferences cannot be saved as a profile');
  await page.getByRole('button',{name:'Sending',exact:true}).click();
  await page.getByPlaceholder('mail.yourcompany.com').fill(`ui-settings-${suffix}.example.test`);
  const added=page.waitForResponse(r=>r.url().endsWith('/api/account/domains') && r.request().method()==='POST');
  await page.getByRole('button',{name:'Add domain',exact:true}).click();
  const domain=await added;assert.equal(domain.status(),201,await domain.text());domainId=(await domain.json()).id;
  await page.getByText(`DNS records · ui-settings-${suffix}.example.test`,{exact:true}).waitFor();
  assert.ok(await page.getByText('TXT',{exact:true}).count()>0,'Real DNS records are presented');
  await page.getByRole('button',{name:'Team & roles',exact:true}).click();
  await page.getByText(`${email} · 2FA`,{exact:false}).first().waitFor();
  assert.equal(await page.getByText('Priya Shah',{exact:true}).count(),0,'No prototype teammates');
  await page.getByRole('button',{name:'Security',exact:true}).click();
  await page.getByText('Active sessions',{exact:true}).waitFor();
  assert.equal(await page.getByText('Activated workflow “Win-back · 90 days”',{exact:true}).count(),0,'No fabricated audit entries');
  await page.getByRole('button',{name:'Billing',exact:true}).last().click();
  await page.getByText('Daily emails',{exact:true}).waitFor();
  assert.equal(await page.getByText('Visa ending 4242 · expires 08/28',{exact:true}).count(),0,'No prototype payment card');
  assert.deepEqual(errors,[]);
  console.log('PASS live profile persistence, strict settings validation, domain creation/DNS, team, security and billing views');
  await context.close();
}catch(error){
  if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:'packages/customer-ui/test-results/settings-failure.png'});}
  throw error;
}finally{
  try{
    if(domainId)assert.equal((await api.delete(`/api/account/domains/${domainId}`)).status(),200);
  }finally{
    try{
      const current=await (await api.get('/api/account/data/profile')).json();
      if(current.customer.name===temporaryName)assert.equal((await api.patch('/api/account/data/profile',{data:{name:original.customer.name}})).status(),200);
    }finally{await browser.close();await api.post('/api/auth/logout',{data:{}});await api.dispose();await anonymous.dispose();}
  }
}
