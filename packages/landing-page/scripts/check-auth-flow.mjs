import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {chromium,request} from '@playwright/test';
const site=process.env.LANDING_ORIGIN || 'http://127.0.0.1:3001',workspace=process.env.CUSTOMER_UI_ORIGIN || 'http://localhost:8080';
const email=`landing-browser-${randomUUID()}@example.test`,password=`LocalLanding!${randomUUID()}`,run=promisify(execFile),errors=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}),context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));let api;
try{
 await page.goto(site+'/create-account');await page.locator('#ca-first').fill('Landing');await page.locator('#ca-last').fill('Browser');await page.locator('#ca-email').fill(email);await page.locator('#ca-pass').fill(password);
 const registered=page.waitForResponse(response=>response.url().endsWith('/api/auth/register') && response.request().method()==='POST');await page.getByRole('button',{name:'Create account',exact:true}).click();assert.equal((await registered).status(),201);
 await page.getByRole('button',{name:`Continue as ${email}`,exact:true}).waitFor();assert.equal(new URL(page.url()).origin,new URL(workspace).origin);assert.equal(new URL(page.url()).hash,'');assert.doesNotMatch(page.url(),/mpu_/);await page.getByRole('button',{name:`Continue as ${email}`,exact:true}).click();
 await page.getByLabel('Company name',{exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/onboarding');await page.getByLabel('Company name',{exact:true}).fill('Landing Browser Workspace');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Skip for now',exact:true}).click();await page.getByText('Create a key in Settings → API keys',{exact:true}).waitFor();await page.getByRole('button',{name:'Finish later',exact:true}).click();
 const token=await page.evaluate(()=>sessionStorage.getItem('valasys.session'));assert.ok(token?.startsWith('mpu_'));api=await request.newContext({baseURL:workspace,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});assert.equal((await (await api.get('/api/account/data/profile')).json()).customer.name,'Landing Browser Workspace');
 console.log('PASS Next registration → explicit single-use handoff → real workspace onboarding and persisted company name');
 await api.post('/api/auth/logout',{data:{}});await page.evaluate(()=>sessionStorage.clear());await page.goto(site+'/sign-in');await page.locator('#si-email').fill(email);await page.locator('#si-pass').fill('WrongPassword!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('status').waitFor();assert.ok((await page.getByRole('status').innerText()).includes('incorrect'));assert.equal(await page.locator('#si-email').inputValue(),email);
 await page.locator('#si-pass').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:`Continue as ${email}`,exact:true}).click();await page.waitForURL(url=>url.origin===new URL(workspace).origin && url.pathname==='/');await page.goto(workspace+'/contacts');await page.getByText('No contacts found',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/NaN|48,168/);
 console.log('PASS invalid/valid Next sign-in with preserved form and authenticated customer UI');
 await page.goto(site+'/talk-to-sales');await page.locator('#ts-first').fill('Landing');await page.locator('#ts-last').fill('Browser');await page.locator('#ts-email').fill(email);await page.locator('#ts-company').fill('Landing Browser QA');await page.locator('#ts-msg').fill('Isolated dummy website integration check.');const saved=page.waitForResponse(response=>response.url().endsWith('/api/landing/sales-requests') && response.request().method()==='POST');await page.getByRole('button',{name:'Request a call',exact:true}).click();assert.equal((await saved).status(),201);await page.getByRole('heading',{name:'Request received',exact:true}).waitFor();
 console.log('PASS Next sales form → actual API persistence → original confirmation design');assert.deepEqual(errors,[]);
}finally{
 await api?.dispose();await browser.close();
 await run('docker',['cp',fileURLToPath(new URL('./cleanup-browser-fixtures.cjs',import.meta.url)),'mail-api:/tmp/cleanup-landing-browser.cjs']);
 const cleaned=await run('docker',['exec','mail-api','node','/tmp/cleanup-landing-browser.cjs',email]);console.log(cleaned.stdout.trim());await run('docker',['exec','--user','0','mail-api','rm','-f','/tmp/cleanup-landing-browser.cjs']);
}
