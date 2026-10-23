// Capture the current customer UI with its built-in demonstration data.
// Run the customer Vite server first; no account or API requests are needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.env.CUSTOMER_UI_ORIGIN || 'http://127.0.0.1:5173';
const pages=[['dashboard','home'],['campaigns','campaigns'],['analytics','analytics'],['messages','messages'],['workflow','automations'],['templates','templates']];
const output=path.join(root,'public/assets/customer-tour');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
 for(const [name,view] of pages){
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2,locale:'en-US',timezoneId:'Asia/Kolkata',reducedMotion:'reduce'});
  try{
   // Keep capture data local to the design preview, never a customer's account.
   await context.route('**/api/**',route=>route.abort());
   const page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.clock.install({time:new Date('2026-10-23T10:00:00+05:30')});
   await page.clock.pauseAt(new Date('2026-10-23T10:00:02+05:30'));
   await page.addInitScript(()=>{Math.random=()=>.5;});
   await page.goto(`${origin}/__design/customer?view=${view}`,{waitUntil:'networkidle'});
   await page.locator('.reference-host').waitFor();
   await page.evaluate(()=>document.fonts.ready);
   if(view==='home'){
    await page.getByTitle('Hide checklist',{exact:true}).click();
    await page.clock.fastForward(5000); // Let the checklist's dismissal toast clear.
   }
   if(errors.length)throw new Error(`${name}: ${errors.join('; ')}`);
   if(await page.getByText('Unable to open this screen',{exact:true}).count())throw new Error(`Unable to render ${name}`);
   await page.screenshot({path:path.join(output,`${name}.png`),animations:'disabled'});
   console.log(`Captured ${name} from customer UI ${view}`);
  }finally{await context.close();}
 }
}finally{await browser.close();}
