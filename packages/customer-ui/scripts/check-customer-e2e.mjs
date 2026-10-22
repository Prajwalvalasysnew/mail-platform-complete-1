// End-to-end production audit of the customer UI: real API server + production bundle + a seeded
// workspace. Visits every route, collects page errors, console errors, failed API calls and visible
// error banners, takes screenshots, then measures frame rate on interaction-heavy surfaces.
// Build shared/api/customer-ui first, then from the repo root:
//   node --env-file=.env.test [--env-file=.env.test.local] packages/customer-ui/scripts/check-customer-e2e.mjs [--fps-only] [--no-fps]
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import shared from '@platform/shared';
const {db,createUserSession,closeDb,closeRedis,closeQueues}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL).pathname))throw new Error('Requires the isolated mail_test database');
const out='packages/customer-ui/test-results/customer-e2e';await mkdir(out,{recursive:true});
const args=new Set(process.argv.slice(2));
const ROUTES=['/','/campaigns','/contacts','/segments','/lists','/messages','/automations','/templates','/analytics','/deliverability','/api-keys','/webhooks','/event-logs','/settings','/domains','/team','/billing','/help','/ai-agent','/email-builder','/workflow-builder','/onboarding'];

const email=`customer-e2e-${randomUUID()}@example.test`;
let customer,user,api,browser,failed=false;const ui=Fastify();const report={routes:[],fps:[]};
async function seed(){
 customer=await db.insertInto('customers').values({email,name:'Northwind Health',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Ada Admin'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 const cid=customer.id,domain=`northwind-${cid.slice(0,8)}.example.test`;
 await db.insertInto('sending_domains').values({customer_id:cid,domain,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true,spf_verified:true,dmarc_verified:true}).execute();
 const templates=[];
 for(const name of ['Welcome','Appointment reminder','Monthly newsletter'])templates.push((await db.insertInto('templates').values({customer_id:cid,name,subject:`${name} subject`,html_body:`<div class="email"><h1>${name}</h1><p>Hello {{first_name}}</p></div>`,text_body:`${name}`}).returning('id').executeTakeFirstOrThrow()).id);
 const contacts=[];
 for(let i=0;i<250;i++)contacts.push({customer_id:cid,email:`patient${i}@example.com`,name:`Patient ${i}`,company:i%3?'Acme':'Globex',location:i%2?'Berlin':'London',status:i%10===0?'Unsubscribed':'Subscribed',consent_confirmed_at:new Date(),tags:i%5?[]:['vip'],attributes:{lead_score:i%100,birthday:'1990-05-14'}});
 const inserted=await db.insertInto('audience_contacts').values(contacts).returning('id').execute();
 const list=await db.insertInto('audience_collections').values({customer_id:cid,kind:'list',name:'Newsletter'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('audience_collection_members').values(inserted.slice(0,120).map(c=>({customer_id:cid,collection_id:list.id,contact_id:c.id}))).execute();
 await db.insertInto('customer_campaigns').values({customer_id:cid,name:'Spring check-up reminder',audience_id:list.id,template_id:templates[1],from_email:`care@${domain}`,from_name:'Northwind',subject:'Time for your check-up'}).execute();
 const statuses=['delivered','delivered','delivered','soft_bounced','hard_bounced','queued','accepted'];
 const messages=Array.from({length:400},(_,i)=>({message_id:`<e2e-${cid}-${i}@${domain}>`,customer_id:cid,from_address:`care@${domain}`,to_address:`patient${i%250}@example.com`,subject:`Message ${i}`,status:statuses[i%statuses.length],ip_pool:i%2?'marketing':'transactional',attempts:1,queued_at:new Date(Date.now()-i*3_600_000),opened_at:i%4===0?new Date(Date.now()-i*3_500_000):null,first_clicked_at:i%9===0?new Date():null,headers:{},tags:[],metadata:{}}));
 for(let i=0;i<messages.length;i+=200)await db.insertInto('messages').values(messages.slice(i,i+200)).execute();
 // Engagement events drive Home and Analytics, so seed the same history the messages describe.
 const events=messages.flatMap(m=>[['queued',m.queued_at],['sent',m.queued_at],...(m.status==='delivered'?[['delivered',m.queued_at]]:[]),...(m.opened_at?[['opened',m.opened_at]]:[]),...(m.first_clicked_at?[['clicked',m.first_clicked_at]]:[])].map(([event_type,at])=>({message_id:m.message_id,customer_id:cid,event_type,payload:{},occurred_at:at})));
 for(let i=0;i<events.length;i+=500)await db.insertInto('events').values(events.slice(i,i+500)).execute();
 const wf=await db.insertInto('workflows').values({customer_id:cid,name:'Appointment reminders',builder_document:{name:'Appointment reminders',tkey:'appt',tcfg:{},settings:{reentry:'every',goal:'none',quiet:true,qFrom:'21:00',qTo:'08:00',tz:'contact',cap:false,capN:3,entry:'all'},graph:{nodes:[{id:'trigger',t:'trigger',x:0,y:0},...Array.from({length:24},(_,i)=>({id:`n${i}`,t:i%3===0?'email':i%3===1?'wait':'update',x:0,y:(i+1)*140,template:templates[0],mode:'duration',amount:1,unit:'days',action:'add_tag',value:'seen'}))],edges:[{id:'e0',from:'trigger',to:'n0',port:'out'},...Array.from({length:23},(_,i)=>({id:`e${i+1}`,from:`n${i}`,to:`n${i+1}`,port:'out'}))]}}}).returning('id').executeTakeFirstOrThrow();
 return {cid,domain,workflowId:wf.id,templateId:templates[0]};
}

try{
 const seeded=await seed();
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const env={...process.env,QUEUE_PREFIX:`customer_e2e_${Date.now()}_`,API_PORT:'3011'};
 let logs='';const keep=d=>{logs=(logs+d).slice(-8000);};
 api=spawn(process.execPath,['packages/api/dist/bootstrap.js'],{env,stdio:['ignore','pipe','pipe']});api.stdout.on('data',keep);api.stderr.on('data',keep);
 // A stale server on the port would answer health checks with an old build, so fail if ours exits.
 let apiExit=null;api.on('exit',code=>{apiExit=code;});
 for(let i=0;;i++){if(apiExit!==null)throw new Error(`API exited (${apiExit}); is port 3011 already in use?\n${logs}`);try{if((await fetch('http://127.0.0.1:3011/health')).ok)break;}catch{}if(i>60)throw new Error(`API did not start\n${logs}`);await new Promise(r=>setTimeout(r,500));}
 await new Promise(r=>setTimeout(r,300));if(apiExit!==null)throw new Error(`API exited (${apiExit}); is port 3011 already in use?\n${logs}`);
 ui.removeAllContentTypeParsers();ui.addContentTypeParser('*',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 ui.all('/api/*',async(req,reply)=>{const r=await fetch(`http://127.0.0.1:3011/v1${req.url.slice(4)}`,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k))),body:['GET','HEAD'].includes(req.method)?undefined:req.body});reply.code(r.status);for(const [k,v] of r.headers)if(!['content-encoding','transfer-encoding','connection'].includes(k))reply.header(k,v);return reply.send(Buffer.from(await r.arrayBuffer()));});
 ui.get('/assets/:file',async(req,reply)=>{const file=req.params.file;if(!/^[\w.-]+$/.test(file))return reply.code(404).send();const type={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';return reply.type(type).send(await readFile(path.join('packages/customer-ui/dist/assets',file)));});
 ui.get('/*',async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
 await ui.listen({port:3101,host:'127.0.0.1'});
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 const page=await context.newPage();page.setDefaultTimeout(20000);
 let current;
 const issues=()=>current;
 page.on('pageerror',e=>issues()?.pageErrors.push(e.message.slice(0,300)));
 page.on('console',m=>{if(m.type()==='error' && !/Failed to load resource/.test(m.text()))issues()?.consoleErrors.push(m.text().slice(0,300));});
 page.on('response',r=>{const u=r.url();if(u.includes('/api/') && r.status()>=400)issues()?.failedRequests.push(`${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/,'').slice(0,140)}`);});
 page.on('requestfailed',r=>{if(r.url().includes('/api/'))issues()?.failedRequests.push(`FAILED ${r.method()} ${r.url().slice(0,140)} ${r.failure()?.errorText}`);});

 if(!args.has('--fps-only'))for(const route of ROUTES){
  current={route,pageErrors:[],consoleErrors:[],failedRequests:[],alerts:[],loadMs:0};
  const t0=Date.now();
  const target=route==='/workflow-builder'?`${route}?id=${seeded.workflowId}`:route==='/email-builder'?`${route}?id=${seeded.templateId}`:route;
  try{await page.goto(`http://127.0.0.1:3101${target}`,{waitUntil:'networkidle',timeout:30000});}catch(e){current.pageErrors.push(`navigation: ${e.message.slice(0,200)}`);}
  await page.waitForTimeout(700);
  current.loadMs=Date.now()-t0;
  current.alerts=(await page.locator('[role=alert]').allInnerTexts().catch(()=>[])).map(t=>t.trim()).filter(Boolean).slice(0,5);
  current.bodyText=(await page.locator('body').innerText().catch(()=>'')).slice(0,200).replace(/\s+/g,' ');
  current.url=page.url().replace('http://127.0.0.1:3101','');
  await page.screenshot({path:`${out}/route${route.replace(/\//g,'_') || '_home'}.png`}).catch(()=>{});
  // Report any small opaque element that renders as a stray black block (a missing icon or font glyph).
  current.strayBlocks=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el);return r.width>4 && r.width<40 && r.height>4 && r.height<40 && cs.visibility!=='hidden' && /^rgb\(0, 0, 0\)$/.test(cs.backgroundColor) && !el.children.length;}).map(el=>{const path=[];for(let p=el;p && path.length<7;p=p.parentElement)path.push(`${p.tagName.toLowerCase()}${p.id?'#'+p.id:''}${typeof p.className==='string' && p.className?'.'+p.className.split(/\s+/)[0]:''}${p.style?.display?'['+p.style.display+']':''}`);return `${path.join(' < ')} @${Math.round(el.getBoundingClientRect().x)},${Math.round(el.getBoundingClientRect().y)}`;}).slice(0,5)).catch(()=>[]);
  if(current.strayBlocks.length)console.log('      stray blocks:',current.strayBlocks.join(' | '));
  report.routes.push(current);
  const bad=current.pageErrors.length+current.consoleErrors.length+current.failedRequests.length+current.alerts.length;
  console.log(`${bad?'ISSUE':'OK   '} ${route.padEnd(18)} ${String(current.loadMs).padStart(5)}ms -> ${current.url}${bad?`\n      ${[...current.pageErrors,...current.consoleErrors,...current.failedRequests,...current.alerts.map(a=>`alert: ${a}`)].join('\n      ')}`:''}`);
 }
 current=undefined;

 if(!args.has('--no-fps')){
  // Frame-rate probe: rAF intervals + long tasks while an interaction runs, with 4x CPU throttling (mid-range laptop/phone).
  const cdp=await context.newCDPSession(page);
  const measure=async(name,setup,interaction)=>{
   await setup();
   await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
   await page.evaluate(()=>{window.__frames=[];window.__long=0;let last=performance.now();const loop=t=>{window.__frames.push(t-last);last=t;if(!window.__stop)requestAnimationFrame(loop);};window.__stop=false;requestAnimationFrame(loop);try{window.__po=new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long+=e.duration>50?1:0;});window.__po.observe({type:'longtask',buffered:false});}catch{}});
   await interaction();
   const r=await page.evaluate(()=>{window.__stop=true;window.__po?.disconnect();const f=window.__frames.slice(2).sort((a,b)=>a-b);const avg=f.reduce((a,b)=>a+b,0)/Math.max(1,f.length);return {frames:f.length,fps:Math.round(1000/avg),p95:Math.round(f[Math.floor(f.length*0.95)] || 0),worst:Math.round(f[f.length-1] || 0),dropped:f.filter(x=>x>25).length,longTasks:window.__long};});
   await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
   report.fps.push({name,...r});
   console.log(`FPS  ${name.padEnd(46)} avg ${String(r.fps).padStart(3)}fps  p95 ${String(r.p95).padStart(4)}ms  worst ${String(r.worst).padStart(4)}ms  janky ${r.dropped}/${r.frames}  long tasks ${r.longTasks}`);
  };
  const drag=async(x1,y1,x2,y2,steps=40)=>{await page.mouse.move(x1,y1);await page.mouse.down();for(let i=1;i<=steps;i++){await page.mouse.move(x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps);}await page.mouse.up();};
  // Wheel over the main content and fail loudly if nothing scrolled, so the probe measures real scrolling.
  const scrolled=()=>page.evaluate(()=>[...document.querySelectorAll('*')].reduce((sum,el)=>sum+el.scrollTop,0)+window.scrollY);
  const scrollContent=async()=>{await page.mouse.move(900,600);const before=await scrolled();for(let i=0;i<30;i++){await page.mouse.wheel(0,120);await page.waitForTimeout(16);}const moved=await scrolled()-before;if(moved<200)throw new Error(`Scroll probe did not scroll (moved ${moved}px)`);};
  const go=async route=>{await page.goto(`http://127.0.0.1:3101${route}`,{waitUntil:'networkidle'});await page.waitForTimeout(500);};
  await measure('Workflow canvas pan (25 steps)',()=>go(`/workflow-builder?id=${seeded.workflowId}`),async()=>{const box=await page.locator('[style*="touch-action: none"]').first().boundingBox();await drag(box.x+box.width/2+200,box.y+300,box.x+box.width/2-150,box.y+100,60);});
  await measure('Workflow canvas wheel zoom',async()=>{},async()=>{const box=await page.locator('[style*="touch-action: none"]').first().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+300);for(let i=0;i<25;i++){await page.mouse.wheel(0,i<12?-80:80);await page.waitForTimeout(16);}});
  await measure('Workflow node drag',async()=>{},async()=>{const node=page.getByText('Then continue').first();const b=await node.boundingBox();if(b)await drag(b.x+20,b.y,b.x+220,b.y+60,50);});
  await measure('Contacts page scroll (250 rows)',()=>go('/contacts'),scrollContent);
  await measure('Messages page scroll (400 messages)',()=>go('/messages'),scrollContent);
  await measure('Sidebar collapse/expand',()=>go('/'),async()=>{const t=page.getByTitle(/Collapse|Expand/).first();for(let i=0;i<4;i++){await t.click().catch(()=>{});await page.waitForTimeout(250);}});
  await measure('Ask AI drawer open/close',()=>go('/'),async()=>{for(let i=0;i<3;i++){await page.getByRole('button',{name:/Ask AI/}).first().click();await page.waitForTimeout(350);await page.keyboard.press('Escape');await page.waitForTimeout(350);}});
  await measure('Email builder canvas scroll',()=>go(`/email-builder?id=${seeded.templateId}`),async()=>{const f=page.locator('.gjs-frame');const b=await f.boundingBox();if(b){await page.mouse.move(b.x+b.width/2,b.y+200);for(let i=0;i<25;i++){await page.mouse.wheel(0,100);await page.waitForTimeout(16);}}});
  await measure('Page navigation (home → campaigns → analytics)',()=>go('/'),async()=>{for(const name of ['Campaigns','Analytics','Contacts','Home']){await page.getByRole('button',{name,exact:true}).first().click().catch(()=>{});await page.waitForTimeout(400);}});
 }
 await writeFile(`${out}/report.json`,JSON.stringify(report,null,1));
 const total=report.routes.reduce((n,r)=>n+r.pageErrors.length+r.consoleErrors.length+r.failedRequests.length,0);
 console.log(`\n${report.routes.length} routes checked, ${total} errors/failed requests. Report: ${out}/report.json`);
}catch(error){failed=true;console.error('FAILED:',error);}
finally{
 await browser?.close();api?.kill();await ui.close();
 if(customer){for(const t of ['events','messages','workflows','customer_campaigns'])await db.deleteFrom(t).where('customer_id','=',customer.id).execute().catch(()=>{});await db.deleteFrom('customers').where('id','=',customer.id).execute();await db.deleteFrom('users').where('id','=',user.id).execute();}
 await closeQueues().catch(()=>{});await closeRedis().catch(()=>{});await closeDb();
 process.exit(failed?1:0);
}
