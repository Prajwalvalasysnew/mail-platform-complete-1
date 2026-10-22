// Fixed synthetic grounding evaluations; never runs against a customer database.
import {randomUUID} from 'node:crypto';
import shared from '../packages/shared/dist/index.js';
const {db,withTenant,createUserSession,createChatTurn,executeAiRun,getAiChat,closeQueues,closeRedis,closeDb}=shared;
if(!/mail_test$/.test(new URL(process.env.DATABASE_URL || '').pathname))throw new Error('Use only the isolated mail_test database');
if(!/^ai_eval_[a-z0-9_]+$/.test(process.env.QUEUE_PREFIX || ''))throw new Error('Use a dedicated ai_eval_ queue prefix');
let customer,user,failed=false;
try{
 const email=`ai-eval-${randomUUID()}@example.test`;
 customer=await db.insertInto('customers').values({email,name:'Synthetic evaluation workspace',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
 user=await db.insertInto('users').values({email,name:'Synthetic evaluation'}).returning('id').executeTakeFirstOrThrow();
 await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
 process.env.AI_ENABLED_TENANTS=customer.id;
 const session=await createUserSession(user.id,{currentCustomerId:customer.id});
 const template=await withTenant(customer.id,async trx=>{
  await trx.insertInto('usage_daily').values({customer_id:customer.id,usage_date:new Date().toISOString().slice(0,10),sent:100,delivered:92,bounced:3,complained:1}).execute();
  return trx.insertInto('templates').values({customer_id:customer.id,name:'Synthetic reference',subject:'CEDAR-482 release note',text_body:'Approved synthetic reference copy.',html_body:null}).returning('id').executeTakeFirstOrThrow();
 });
 const historyId=randomUUID(),exact='Original instruction: use project label CORAL-918 and never invent pricing.';
 await withTenant(customer.id,async trx=>{
  await trx.insertInto('ai_chats').values({id:historyId,customer_id:customer.id,user_id:user.id,title:'Synthetic older conversation',settings:{},expires_at:new Date(Date.now()+3600000)}).execute();
  await trx.insertInto('ai_chat_messages').values({id:randomUUID(),customer_id:customer.id,chat_id:historyId,run_id:null,seq:1,role:'user',text:exact,status:'completed',result:{context_settings:{}},error:null,template_id:null,decision:null}).execute();
 });
 await withTenant(customer.id,trx=>trx.insertInto('sending_domains').values(Array.from({length:23},(_,n)=>({customer_id:customer.id,domain:`fixture-${n}.example.test`,dkim_selector:'s1',dkim_public_key:'synthetic',dkim_private_key:'not-a-real-key',verification_token:randomUUID()}))).execute());
 const domainChat=randomUUID(),editorChat=randomUUID();
 const cases=[
  {name:'exact-user-domain-question',chatId:domainChat,operation:'assist',instruction:"how many domain's I have connected?",settings:{},tool:'domain_status',check:text=>/23/.test(text)},
  {name:'domain-follow-up-without-keywords',chatId:domainChat,operation:'assist',instruction:'and how many are verified?',settings:{},tool:'domain_status',check:text=>/\b0\b|none|no domains/i.test(text)},
  {name:'designed-product-demo',chatId:editorChat,operation:'editor',instruction:'Create high quality product demo html template',settings:{editor:{key:editorChat,content:'',subject:'',tone:'Professional'}},check:(text,m)=>m.result?.operation==='draft' && m.result.html.includes('role="presentation"') && m.result.html.includes('<h1') && !/dear|\{\{|urgent:|exclusive offer/i.test(text)},
  {name:'editor-follow-up',chatId:editorChat,operation:'editor',instruction:'Make the headline shorter, use the ocean color theme and keep this exact phrase: CEDAR-482 preview.',settings:{editor:{key:editorChat,content:'CEDAR-482 preview. Explore our product demo at your own pace.',subject:'Explore the product demo',tone:'Professional'}},check:(text,m)=>m.result?.operation==='draft' && m.result.design?.theme==='ocean' && text.includes('CEDAR-482 preview')},

  {name:'delivery-facts',instruction:'Read my actual workspace delivery summary for 7 days. Return Delivered: [count]; Bounced: [count]. Do not invent open rates or causes.',settings:{},tool:'delivery_summary',check:text=>/Delivered[^0-9]*92/i.test(text) && /Bounced[^0-9]*3/i.test(text)},
  {name:'selected-template',instruction:'Quote the exact subject of the selected template. Do not invent additional content.',settings:{context:[{kind:'template',id:template.id,label:'Synthetic reference'}]},tool:'read_template',check:text=>text.includes('CEDAR-482 release note')},
  {name:'exact-history-retrieval',instruction:'Search my earlier chat history for the literal phrase "never invent pricing" and quote the complete original user message exactly.',settings:{},tool:'search_history',check:text=>text.includes(exact)},
 ];
 for(const item of cases){
  const id=item.chatId || randomUUID(),started=Date.now();
  const run=await createChatTurn(customer.id,user.id,session.session_id,id,{request_id:randomUUID(),operation:item.operation || 'assist',instruction:item.instruction,settings:item.settings});
  await executeAiRun(customer.id,run.id,new AbortController().signal);
  const saved=await getAiChat(customer.id,user.id,id),message=saved.messages.at(-1),tools=saved.steps.filter(s=>s.status==='completed' && s.run_id===message.run_id).map(s=>s.name);
  const pass=message.status==='completed' && item.check(message.text,message) && (!item.tool || tools.includes(item.tool));if(!pass)failed=true;
  console.log(JSON.stringify({evaluation:item.name,status:pass?'passed':'failed',duration_ms:Date.now()-started,completed_reads:tools.filter(x=>x!=='read_plan'),run_status:message.status}));
 }
}finally{
 if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();
 if(user)await db.deleteFrom('users').where('id','=',user.id).execute();
 await closeQueues();await closeRedis().catch(()=>undefined);await closeDb();
}
if(failed)process.exitCode=1;
