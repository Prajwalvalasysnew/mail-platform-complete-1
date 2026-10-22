import { chromium } from '@playwright/test';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const base='http://127.0.0.1:5173';
const failures=[];
async function check(name,run){
  const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
  if(only && !name.includes(only))return;
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{await run(page);if(errors.length)throw new Error(errors.join('; '));console.log(`PASS ${name}`);}
  catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.message}`);}
  finally{await context.close();}
}
try{
  await check('campaign table and create dialog',async page=>{
    await page.goto(`${base}/__design/customer?view=campaigns`);
    await page.getByRole('button',{name:'Create campaign',exact:true}).click();
    await page.getByRole('textbox').filter({hasNot:page.locator('[placeholder="Search pages, contacts, campaigns..."]')}).count();
    if(await page.getByText('Campaign name',{exact:true}).count()===0)throw new Error('Campaign dialog did not open');
  });
  await check('customer navigation and settings tabs',async page=>{
    await page.goto(`${base}/__design/customer?view=home`);
    await page.getByRole('button',{name:'Settings',exact:true}).first().click();
    await page.getByRole('button',{name:'Security',exact:true}).click();
    await page.getByText('Session timeout',{exact:true}).waitFor();
  });
  await check('AI routines and memory panels',async page=>{
    await page.goto(`${base}/__design/agent`);
    await page.getByRole('button',{name:/^Routines/}).click();
    await page.getByRole('button',{name:/^Memory/}).click();
    if(await page.locator('textarea').count()===0)throw new Error('Memory editor missing');
  });
  await check('workflow canvas and step inspector',async page=>{
    await page.goto(`${base}/__design/workflow`);
    await page.getByText('Welcome to Acme',{exact:true}).first().click();
    await page.getByText('Subject line',{exact:true}).first().waitFor();
    if(await page.getByText('Unable to open this screen').count())throw new Error('Workflow render failed');
  });
  await check('email builder canvas and device switching',async page=>{
    await page.goto(`${base}/__design/email`);
    await page.locator('.gjs-frame').waitFor({timeout:30000});
    await page.getByRole('button',{name:'Mobile',exact:true}).click();
    const frame=page.locator('.gjs-frame-wrapper').first();
    await page.waitForTimeout(400);
    const width=await frame.evaluate(el=>el.getBoundingClientRect().width);
    if(width>500)throw new Error(`Mobile canvas width is ${width}`);
  });
  if(process.env.CUSTOMER_UI_TEST_EMAIL && process.env.CUSTOMER_UI_TEST_PASSWORD){
    await check('real customer login and authenticated API key page',async page=>{
      await page.goto(`${base}/login`);
      await page.locator('[name=email]').fill(process.env.CUSTOMER_UI_TEST_EMAIL);
      await page.locator('[name=password]').fill(process.env.CUSTOMER_UI_TEST_PASSWORD);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByRole('button',{name:'API keys',exact:true}).click({timeout:30000});
      await page.getByRole('button',{name:'Create key',exact:true}).first().waitFor();
      if(await page.getByText('Unable to open this screen').count())throw new Error('Authenticated view failed');
    });
  }
} finally{await browser.close();}
if(failures.length)process.exitCode=1;
