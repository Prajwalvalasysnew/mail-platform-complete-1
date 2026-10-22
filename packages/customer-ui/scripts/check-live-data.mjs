// Browser-level API contract test. Only message/analytics responses are mocked;
// authentication and workspace identity use the real local API.
import assert from 'node:assert/strict';
import {chromium,request} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const origin=process.env.CUSTOMER_UI_ORIGIN || 'http://127.0.0.1:5173';
const email=process.env.CUSTOMER_UI_TEST_EMAIL,password=process.env.CUSTOMER_UI_TEST_PASSWORD;
if(!email || !password)throw new Error('Set CUSTOMER_UI_TEST_EMAIL and CUSTOMER_UI_TEST_PASSWORD.');
const anonymous=await request.newContext({baseURL:origin});
const login=await anonymous.post('/api/auth/login',{data:{email,password}});assert.equal(login.status(),200);
const {token}=await login.json();
const api=await request.newContext({baseURL:origin,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});
assert.equal((await api.get('/api/account/data/messages/activity?days=7&limit=1')).status(),200,'Real activity endpoint');
const messages=await api.get('/api/account/data/messages?limit=1');assert.equal(messages.status(),200,'Real message endpoint');
for(const message of (await messages.json()).messages)assert.ok(['commercial','transactional','relationship'].includes(message.message_class),'Message classification is projected by the API');
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const now=new Date().toISOString();
const rows=['queued','accepted','soft_bounced','hard_bounced','delivered'].map((status,index)=>({message_id:`ui-contract-${status}`,from_address:'actual-sender@example.test',to_address:'recipient@example.test',subject:`Contract message ${index}`,status,message_class:'commercial',template_id:null,queued_at:now,opened_at:status==='delivered'?now:null,first_clicked_at:null}));
let page;
try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(value=>sessionStorage.setItem('valasys.session',value),token);
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',event=>{if(event.type()==='error' && event.text().includes('Customer UI render failed'))errors.push(event.text());});
  await page.route('**/api/account/data/analytics/summary?*',route=>route.fulfill({json:{period:'7d',sent:100,delivered:80,bounced:5,complained:1,opened:40,clicked:8,unsubscribed:2,delivery_rate:0.8,open_rate:0.5,click_rate:0.1}}));
  await page.route('**/api/account/data/analytics/timeseries?*',route=>route.fulfill({json:{granularity:'day',series:[{date:now,sent:100,delivered:80,opened:40,clicked:8,bounced:5}]}}));
  await page.route('**/api/account/data/messages?*',route=>route.fulfill({json:{messages:rows}}));
  await page.route('**/api/account/data/messages/ui-contract-queued',route=>route.fulfill({json:{message:rows[0],events:[{event_type:'queued',occurred_at:now,payload:{}}]}}));
  await page.route('**/api/account/data/messages/activity?*',route=>route.fulfill({json:{events:[
    {...rows[0],event_id:301,event_type:'queued',occurred_at:now,payload:{response:'Queued by message service'}},
    {...rows[3],subject:'=SUM(1,2)',event_id:300,event_type:'hard_bounce',occurred_at:now,payload:{response:'550 unavailable contact@example.test'}},
  ],next_cursor:null}}));
  await page.goto(origin);
  await page.getByText('80.0%',{exact:true}).waitFor();
  await page.getByText('50.0%',{exact:true}).waitFor();
  await page.getByText('Not measured',{exact:true}).waitFor();
  assert.equal(await page.getByText('96.4%',{exact:true}).count(),0,'No sample inbox-placement score');
  assert.equal(await page.getByText('One DNS change would lift your reputation score to 97',{exact:true}).count(),0,'No invented AI insight');
  const paths=await page.locator('path').evaluateAll(elements=>elements.map(element=>element.getAttribute('d')));
  assert.ok(paths.includes('M0,10'),'Delivered series uses the common axis');
  assert.ok(paths.includes('M0,115'),'Open series uses the same axis, not its own maximum');
  await page.getByRole('button',{name:'Messages',exact:true}).click();
  await page.getByText('Contract message 0',{exact:true}).waitFor();
  for(const label of ['Queued','Accepted','Soft bounced','Hard bounced','Delivered'])await page.getByText(label,{exact:true}).first().waitFor();
  await page.getByText('Contract message 0',{exact:true}).click();
  await page.getByText('actual-sender@example.test',{exact:true}).waitFor();
  assert.equal(await page.getByText('250 2.0.0 OK — accepted by mx.example.test',{exact:true}).count(),0,'No fictional SMTP response');
  await page.getByRole('button',{name:'JSON',exact:true}).click();
  await page.getByText('"event_type": "queued"',{exact:false}).waitFor();
  await page.getByTitle('Close',{exact:true}).click();
  await page.getByRole('button',{name:'Event logs',exact:true}).click();
  await page.getByText('Queued by message service',{exact:true}).waitFor();
  const download=page.waitForEvent('download');
  await page.getByTitle('Export filtered events as CSV',{exact:true}).click();
  const csv=await readFile(await (await download).path(),'utf8');
  assert.ok(csv.includes('"\'=SUM(1,2)"'),'Export neutralizes spreadsheet formulas in message subjects');
  await page.getByText('=SUM(1,2)',{exact:true}).click();
  await page.getByRole('button',{name:'Headers',exact:true}).click();
  await page.getByText('Message headers are not included in the activity feed.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Resend',exact:true}).count(),0,'No simulated resend action');
  await page.getByRole('button',{name:'Raw JSON',exact:true}).click();
  await page.getByText('"event_type": "hard_bounce"',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS home metrics/shared chart axis, no fixture scores or AI claims, actual delivery statuses, message details, live event feed and safe CSV export');
  await context.close();
}catch(error){if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:'packages/customer-ui/test-results/live-data-failure.png'});}throw error;}
finally{await browser.close();await api.post('/api/auth/logout',{data:{}});await api.dispose();await anonymous.dispose();}
