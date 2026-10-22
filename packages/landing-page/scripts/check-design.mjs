import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(root,'../..');
const site=process.env.LANDING_ORIGIN || 'http://127.0.0.1:3001',reference='http://127.0.0.1:3002';
const output=path.join(root,'test-results');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
let fontCss='';
for(const [family,files] of [['instrument-sans',['index.css']],['inter',['400.css','500.css','600.css','700.css','800.css']],['inter-tight',['600.css','700.css','800.css']],['jetbrains-mono',['400.css','500.css','600.css','700.css']]]){
 const prefix=family==='instrument-sans'?'@fontsource-variable':'@fontsource';
 for(const file of files)fontCss+=(await fs.readFile(path.join(repo,'node_modules',prefix,family,file),'utf8')).replaceAll('Instrument Sans Variable','Instrument Sans').replace(/url\(\.\/files\/([^)]*)\)/g,`url(${reference}/_fonts/${family}/$1)`);
}
async function context(width){
 const ctx=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,locale:'en-US',timezoneId:'Asia/Kolkata',reducedMotion:'reduce'});
 await ctx.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:fontCss}));
 for(const name of ['react','react-dom'])await ctx.route(`https://unpkg.com/${name}@18.3.1/umd/${name}.production.min.js`,async route=>route.fulfill({contentType:'application/javascript',body:await fs.readFile(path.join(repo,'node_modules',name,'umd',`${name}.production.min.js`))}));
 return ctx;
}
const results=[],errors=[];
try{
 for(const width of [1440,390])for(const [name,source,route] of [['landing','Valasys Mail Landing v13.dc.html','/'],['sign-in','Sign In.dc.html','/sign-in'],['create-account','Create Account.dc.html','/create-account'],['sales','Talk to Sales.dc.html','/talk-to-sales']]){
  const images=[];
  for(const [kind,url] of [['reference',`${reference}/${encodeURIComponent(source)}`],['next',site+route]]){
   const ctx=await context(width),page=await ctx.newPage();page.on('pageerror',error=>errors.push(`${name} ${width} ${kind}: ${error.message}`));
   await page.clock.install({time:new Date('2026-10-17T00:00:00+05:30')});
   await page.clock.pauseAt(new Date('2026-10-17T00:05:00+05:30'));
   await page.addInitScript(()=>{Math.random=()=>.5;});
   await page.goto(url,{waitUntil:'networkidle'});await page.locator('h1:visible').first().waitFor();await page.evaluate(()=>document.fonts.ready);
   if(kind==='next')await page.locator('html[data-landing-hydrated="true"]').waitFor();
  await page.clock.fastForward(60000);
   const shot=await page.screenshot({path:path.join(output,`${name}-${width}-${kind}.png`),fullPage:true,animations:'disabled'});images.push(PNG.sync.read(shot));await ctx.close();
  }
  assert.equal(images[0].width,images[1].width,`${name} screenshot width`);assert.equal(images[0].height,images[1].height,`${name} screenshot height`);
  const diff=new PNG({width:images[0].width,height:images[0].height}),pixels=pixelmatch(images[0].data,images[1].data,diff.data,diff.width,diff.height,{threshold:.1}),percentage=pixels/(diff.width*diff.height)*100;
  await fs.writeFile(path.join(output,`${name}-${width}-diff.png`),PNG.sync.write(diff));const result={name,width,percentage:Number(percentage.toFixed(4)),pixels};results.push(result);console.log(JSON.stringify(result));
 }
 const ctx=await context(1440),page=await ctx.newPage();page.on('pageerror',error=>errors.push(`interaction: ${error.message}`));await page.goto(site,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Python',exact:true}).click();assert.ok((await page.locator('pre').first().innerText()).includes('from valasys import Mail'));
 await page.getByRole('button',{name:'cURL',exact:true}).click();assert.ok((await page.locator('pre').first().innerText()).includes('curl https://'));
 await page.getByRole('button',{name:'Annual · save 20%',exact:true}).click();assert.ok((await page.locator('#pricing').innerText()).includes('$20'));
 await page.getByRole('button',{name:'Monthly',exact:true}).click();assert.ok((await page.locator('#pricing').innerText()).includes('$25'));
 await page.getByRole('button',{name:'Analytics',exact:true}).click();await page.waitForFunction(()=>document.querySelector('img[src*="shot-analytics"]')?.complete);assert.ok(await page.locator('img[src*="shot-analytics"]').count());
 await page.getByRole('button').filter({hasText:'Do I get a dedicated IP?'}).click();assert.ok((await page.locator('body').innerText()).includes('Enterprise includes dedicated pools'));
 await page.getByRole('button',{name:'Send me a test',exact:true}).click();await page.getByRole('status').waitFor();assert.doesNotMatch(await page.getByRole('status').innerText(),/sent successfully|delivered to/);await page.getByRole('button',{name:'Dismiss message'}).click();
 await page.getByRole('button',{name:'Check domain',exact:true}).click();assert.ok((await page.getByRole('status').innerText()).includes('actual DNS records'));await page.getByRole('button',{name:'Dismiss message'}).click();
 await page.goto(site+'/sign-in');await page.locator('#si-pass').fill('DummyPassword!1');await page.getByRole('button',{name:'Toggle password visibility'}).click();assert.equal(await page.locator('#si-pass').getAttribute('type'),'text');
 await page.goto(site+'/create-account');await page.locator('#ca-pass').fill('DummyPassword!123');assert.ok((await page.locator('body').innerText()).includes('Strong'));
 await page.route('**/api/landing/sales-requests',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Sales temporarily unavailable. Nothing was saved by this mocked check.'})}));await page.goto(site+'/talk-to-sales');await page.locator('#ts-first').fill('Dummy');await page.locator('#ts-email').fill('dummy@example.test');await page.locator('#ts-company').fill('Local QA');await page.getByRole('button',{name:'Request a call'}).click();assert.ok((await page.getByRole('status').innerText()).includes('temporarily unavailable'));assert.equal(await page.getByText('Request received',{exact:true}).count(),0);
 await ctx.close();
 const preview=await context(1440),hero=await preview.newPage();await hero.goto(site,{waitUntil:'networkidle'});await hero.evaluate(()=>document.fonts.ready);await hero.screenshot({path:path.join(output,'landing-desktop-hero.png'),animations:'disabled'});assert.equal((await preview.request.get(site+'/support.js')).status(),404);assert.equal((await preview.request.get(site+'/design-reference/Sign%20In.dc.html')).status(),404);const html=await (await preview.request.get(site)).text();assert.ok(html.includes('Email that reaches'));await preview.close();
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({results,errors,interactions:'passed'},null,2));assert.deepEqual(errors,[]);assert.ok(results.every(result=>result.percentage<.1),'Visual difference must be below 0.1%');console.log('PASS eight desktop/mobile comparisons and interactive controls; no runtime errors');
}finally{await browser.close();}
