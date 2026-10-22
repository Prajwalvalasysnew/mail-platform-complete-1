// Production-bundle browser acceptance for the workflow builder: industry trigger, step options in
// the inspector, rule builder, issues, autosave and publish, against the real API server.
// Build shared/api/customer-ui first, then from the repo root:
//   node --env-file=.env.test [--env-file=.env.test.local] packages/customer-ui/scripts/check-workflow-builder-browser.mjs
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import shared from '@platform/shared';
const {db,createUserSession,closeDb,closeRedis,closeQueues}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL).pathname))throw new Error('Browser verification requires the isolated mail_test database');
const out='packages/customer-ui/test-results/workflow-builder';await mkdir(out,{recursive:true});
const prefix=`workflow_browser_${Date.now()}_`;

const email=`workflow-builder-${randomUUID()}@example.test`;
let customer,user,api,browser,failed=false;const ui=Fastify();
try{
 customer=await db.insertInto('customers').values({email,name:'Workflow builder check',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Workflow builder check'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 await db.insertInto('templates').values({customer_id:customer.id,name:'Appointment confirmation',subject:'Your appointment',html_body:'<p>See you soon</p>',text_body:'See you soon'}).execute();
 const domain=`clinic-${customer.id.slice(0,8)}.example.test`;
 await db.insertInto('sending_domains').values({customer_id:customer.id,domain,dkim_selector:'s1',dkim_public_key:'p',dkim_private_key:'k',verification_token:randomUUID(),verified_at:new Date(),dkim_verified:true}).execute();
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const env={...process.env,QUEUE_PREFIX:prefix,API_PORT:'3011'};
 let logs='';const keep=d=>{logs=(logs+d).slice(-6000);};
 api=spawn(process.execPath,['packages/api/dist/bootstrap.js'],{env,stdio:['ignore','pipe','pipe']});api.stdout.on('data',keep);api.stderr.on('data',keep);
 for(let i=0;;i++){try{if((await fetch('http://127.0.0.1:3011/health')).ok)break;}catch{}if(i>60)throw new Error(`API did not start\n${logs}`);await new Promise(r=>setTimeout(r,500));}
 ui.removeAllContentTypeParsers();ui.addContentTypeParser('*',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 ui.all('/api/*',async(req,reply)=>{const r=await fetch(`http://127.0.0.1:3011/v1${req.url.slice(4)}`,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k))),body:['GET','HEAD'].includes(req.method)?undefined:req.body});reply.code(r.status);for(const [k,v] of r.headers)if(!['content-encoding','transfer-encoding','connection'].includes(k))reply.header(k,v);return reply.send(Buffer.from(await r.arrayBuffer()));});
 ui.get('/assets/:file',async(req,reply)=>{const file=req.params.file;if(!/^[\w.-]+$/.test(file))return reply.code(404).send();const type={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';return reply.type(type).send(await readFile(path.join('packages/customer-ui/dist/assets',file)));});
 ui.get('/*',async(_req,reply)=>reply.type('text/html').send(await readFile('packages/customer-ui/dist/index.html')));
 await ui.listen({port:3101,host:'127.0.0.1'});

 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(token=>{if(window.top===window)sessionStorage.setItem('valasys.session',token);},session.token);
 await page.goto('http://127.0.0.1:3101/workflow-builder');
 await page.getByText('New unsaved draft').waitFor({timeout:45000});
 const shot=n=>page.screenshot({path:`${out}/${n}.png`});
 const pick=async(current,option)=>{await page.getByText(current,{exact:true}).last().click();await page.getByText(option,{exact:true}).last().click();};
 // Trigger: healthcare industry event.
 await page.getByText('Trigger',{exact:true}).first().click();
 await page.getByText('Start when').waitFor();
 await pick('Custom event from your system','Appointment is booked');
 await page.locator('input[value="appointment_booked"]').waitFor();
 console.log('Browser: industry trigger shows its event name');
 await shot('1-trigger');
 // Email step with a real template and subject override.
 await page.getByText('Send email',{exact:true}).first().click();
 await page.getByText('Choose a template…').last().click();
 await page.getByText('Appointment confirmation',{exact:true}).last().click();
 await page.getByPlaceholder('Your appointment').fill('See you soon, {{first_name}}');
 // Wait one day before the appointment.
 await page.getByText('Wait',{exact:true}).first().click();
 await pick('Delay','Before or after a date');
 await page.locator('input[value="context.appointment_at"]').waitFor();
 await shot('2-wait-date');
 // If/else on a contact tag via the rule builder.
 await page.getByText('If / else',{exact:true}).first().click();
 await page.getByText('Quick pick…').last().click();
 await page.getByText('Has the VIP tag',{exact:true}).last().click();
 await page.getByText('+ Add rule').last().click();
 await shot('3-rules');
 await page.waitForTimeout(500);
 const issues=await page.locator('button').filter({hasText:/No issues|to fix|suggestion/}).first().innerText();
 console.log('Browser: issues indicator:',issues.trim());
 await page.getByText('Saved to workspace').waitFor({timeout:20000});
 const saved=await db.selectFrom('workflows').select(['id','builder_document']).where('customer_id','=',customer.id).executeTakeFirstOrThrow();
 const doc=saved.builder_document;
 console.log('Browser: saved steps',doc.graph.nodes.map(n=>n.t).join(' → '),'trigger',doc.tkey);
 if(doc.tkey!=='appt')throw new Error('Trigger not saved');
 // The added empty rule blocks publishing with a precise issue.
 if(!/to fix/.test(issues))throw new Error(`Expected a blocking issue for the empty rule, got ${issues}`);
 await page.getByText('Remove rule').last().click();
 await page.locator('button').filter({hasText:/No issues|suggestion/}).first().waitFor();
 await page.getByText('Saved to workspace').waitFor({timeout:20000});
 await page.getByRole('button',{name:'Activate'}).first().click();
 await shot('4-activate');
 await page.getByRole('button',{name:/Activate|Publish|Go live/}).last().click();
 await page.getByText(/Published version 1/).waitFor({timeout:20000});
 const live=await db.selectFrom('workflows').innerJoin('workflow_versions','workflow_versions.id','workflows.published_version_id').select(['workflows.status','workflow_versions.definition']).where('workflows.id','=',saved.id).executeTakeFirstOrThrow();
 if(live.status!=='active' || live.definition.trigger.event_name!=='appointment_booked')throw new Error('Published definition is wrong: '+JSON.stringify(live.definition.trigger));
 console.log('Browser: published steps',JSON.stringify(live.definition.steps.map(s=>s.type)));
 await shot('5-published');
 if(errors.length)throw new Error(`Page errors: ${errors.join(' | ')}`);
 console.log('Workflow builder browser acceptance passed. Screenshots in',out);
}catch(error){failed=true;console.error('FAILED:',error);await browser?.contexts()[0]?.pages()[0]?.screenshot({path:`${out}/failure.png`}).catch(()=>{});}
finally{
 await browser?.close();api?.kill();await ui.close();
 if(customer){await db.deleteFrom('customers').where('id','=',customer.id).execute();await db.deleteFrom('users').where('id','=',user.id).execute();}
 await closeQueues().catch(()=>{});await closeRedis().catch(()=>{});await closeDb();
 process.exit(failed?1:0);
}
