import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const width=Number(process.argv.find(arg=>arg.startsWith('--width='))?.slice(8) || 1440);
const output=path.join(root,'test-results',width===1440?'design':`design-${width}`);
fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const checks = process.argv.includes('--quick') ? [['onboarding','/','/__design/customer']] : [
  ['onboarding','/','/__design/customer'],
  ...['home','campaigns','contacts','messages','segments','lists','automations','templates','analytics','deliverability','apikeys','webhooks','logs','settings','help'].map(view=>[view,`/?view=${view}`,`/__design/customer?view=${view}`]),
  ['agent','/AI%20Agent.dc.html','/__design/agent'],
  ['workflow','/Workflow%20Builder.dc.html','/__design/workflow'],
  ['email','/Email%20Builder.dc.html','/__design/email'],
];
const results=[];
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
try {
  for (const [name,original,react] of checks) {
    if(only && !only.includes(name))continue;
    const images=[]; const errors=[];
    for (const [kind,url] of [['reference',`${process.env.DESIGN_REFERENCE_ORIGIN || 'http://localhost:8081'}${original}`],['react',`http://127.0.0.1:5173${react}`]]) {
      const context=await browser.newContext({viewport:{width,height:900},locale:'en-US',timezoneId:'Asia/Kolkata'});
      const page=await context.newPage();
      // Freeze timers as well as Date: the reference's simulated live log feed
      // otherwise ticks at different wall-clock moments while pages load.
      if(name==='logs'){
        await page.clock.install({time:new Date('2026-10-15T11:59:00.000Z')});
        await page.clock.pauseAt(new Date('2026-10-15T12:00:00.000Z'));
      }else await page.clock.setFixedTime(new Date('2026-10-15T12:00:00.000Z'));
      page.on('pageerror',error=>errors.push(`${kind}: ${error.message}`));
      page.on('console',event=>{if(event.type()==='error' && event.text().includes('Customer UI render failed')) errors.push(`${kind}: ${event.text()}`);});
      await page.goto(url,{waitUntil:'networkidle'});
      if(name==='email'){
        // The reference's fixed editor panels can collapse the canvas at a
        // narrow viewport. Require real loaded content, not iframe visibility.
        await page.waitForFunction(()=>!!document.querySelector('.gjs-frame')?.contentDocument?.querySelector('.email'),{},{timeout:45000});
      }
      await page.waitForTimeout(name==='email'?4500:1200);
      await page.evaluate(()=>document.fonts.ready);
      if(name==='email' && kind==='react' && process.argv.includes('--inspect-dom'))console.log(await page.locator('.gjs-block-category .gjs-title').first().evaluate(element=>({html:element.outerHTML,padding:getComputedStyle(element).padding})));
      await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}'});
      const image=await page.screenshot({path:path.join(output,`${name}-${kind}.png`)});
      images.push(PNG.sync.read(image));
      await context.close();
    }
    const [a,b]=images; const diff=new PNG({width:a.width,height:a.height});
    const pixels=pixelmatch(a.data,b.data,diff.data,a.width,a.height,{threshold:0.15});
    fs.writeFileSync(path.join(output,`${name}-diff.png`),PNG.sync.write(diff));
    const result={name,differentPixels:pixels,percentage:Number((pixels/(a.width*a.height)*100).toFixed(3)),errors};
    results.push(result); console.log(JSON.stringify(result));
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
if(results.some(result=>result.errors.length || result.percentage>Number(process.env.DESIGN_MAX_DIFFERENCE_PERCENT || 0.05)))process.exitCode=1;
