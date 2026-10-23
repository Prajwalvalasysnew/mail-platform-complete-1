// Run inside the local API container with AI_NEWSLETTER_LOCAL_QA=true.
// Uses the actual AI worker and only an isolated, automatically removed QA tenant.
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {load}=require('/app/node_modules/cheerio');
const {db,createUserSession,closeDb,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
 if(process.env.AI_NEWSLETTER_LOCAL_QA!=='true' || process.env.NODE_ENV!=='development' || new URL(process.env.DATABASE_URL).hostname!=='postgres')throw new Error('This check requires the explicit local development stack.');
 let customer,user;
 try{
  const email=`newsletter-qa-${randomUUID()}@example.test`;
  customer=await db.insertInto('customers').values({email,name:'Newsletter QA',email_verified_at:new Date()}).returning('id').executeTakeFirstOrThrow();
  user=await db.insertInto('users').values({email,name:'Newsletter QA'}).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('memberships').values({customer_id:customer.id,user_id:user.id,role:'owner'}).execute();
  const session=await createUserSession(user.id,{currentCustomerId:customer.id});
  const call=async(path,body)=>{const response=await fetch('http://127.0.0.1:3000/v1'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(`${path}: ${response.status} ${result.error || ''}`);return result;};
  const chat=randomUUID();
  const instruction='Create a complete, polished B2B marketing newsletter for Valasys Media, tagline "B2B Marketing. Smarter.". Use a 600px white email on pale #f2f6fb, blue #176de0 accents, dark navy #123a70 headings, and a #102e59 footer. Include a branded header; a light-blue hero with eyebrow STAY AHEAD, heading "Smarter Marketing for a Brighter Tomorrow", a short supporting paragraph and "Explore Our Solutions" button linking to https://valasys.com/; an "Our Services" section with FOUR titled service cards arranged in TWO columns: Email Campaigns (engaging audience messages), Audience Segments (targeted communication), Analytics (campaign performance and engagement), Marketing Support (consistent customer experiences); a second shaded CTA with heading "Ready to Get Started?" and "Contact Our Team" button to https://valasys.com/; and a dark branded footer with website and unsubscribe links. Use only the facts above, no invented claims. Build the entire design now.';
  const submitted=await call(`/account/ai/chats/${chat}/turns`,{request_id:randomUUID(),operation:'editor',instruction,settings:{timezone:'Asia/Kolkata',editor:{key:chat,links:['https://valasys.com/'],html:'<div class="email"><p>Add your email content here.</p></div>',content:'Add your email content here.',subject:'',preheader:'',tone:'Professional',section:false}}});
  let run,last='';const deadline=Date.now()+540000;
  do{
   await new Promise(resolve=>setTimeout(resolve,1500));run=await call(`/account/ai/runs/${submitted.id}`);
   const status=[run.status,...(run.steps || []).map(step=>`${step.name}:${step.status}`)].join(' ');
   if(status!==last){console.log(status);last=status;}
  }while(['queued','running'].includes(run.status) && Date.now()<deadline);
  assert.equal(run.status,'completed',run.error || 'The live request did not complete');assert.equal(run.result?.operation,'draft');
  const draft=run.result;
  fs.writeFileSync('/tmp/valasys-newsletter-live.html','<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">'+draft.html+'</body></html>');
  fs.writeFileSync('/tmp/valasys-newsletter-live.json',JSON.stringify(draft,null,2));
  assert.match(draft.html,/<h1\b/i);assert.match(draft.html,/max-width:\s*600px/i);
  for(const text of ['Valasys Media','Our Services','Email Campaigns','Audience Segments','Analytics','Marketing Support','Ready to Get Started?','Contact Our Team'])assert.ok(draft.html.includes(text),`Missing ${text}`);
  assert.ok((draft.html.match(/width=["']50%["']/g) || []).length>=4,'The services need a two-column grid');
  assert.match(draft.html,/#102e59/i);assert.doesNotMatch(draft.html,/\u00a9\s*20\d{2}|&copy;\s*20\d{2}/i,'Do not invent copyright years');assert.ok(draft.html.includes('{{unsubscribe_url}}'));assert.doesNotMatch(draft.html,/<script|onerror=/i);
  const $=load(draft.html);
  assert.ok($('table[width="600"]').first().find('tr').first().text().includes('B2B Marketing. Smarter.'),'The tagline belongs in the brand header');
  assert.ok(!$('h1').first().text().includes('STAY AHEAD'),'The eyebrow must not be part of the hero headline');
  const closing=$('a').filter((_i,link)=>$(link).text()==='Contact Our Team').closest('table').parent('td');
  assert.match(closing.attr('style') || '',/background-color:/,'The closing CTA needs one shaded band');
  assert.ok(draft.html.includes('Visit our website'),'The requested footer website link must be present');
  const saved=await call('/account/data/templates',{name:'Live AI newsletter verification',subject:draft.subject,html_body:draft.html,text_body:draft.text,editor_document:{schemaVersion:1,preheader:draft.preheader,ai_chat_id:chat}});
  const restored=await call(`/account/data/templates/${saved.id}`);assert.equal(restored.html_body,draft.html);
  fs.writeFileSync('/tmp/valasys-newsletter-live.html','<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">'+draft.html+'</body></html>');
  fs.writeFileSync('/tmp/valasys-newsletter-live.json',JSON.stringify({subject:draft.subject,preheader:draft.preheader,html:draft.html,text:draft.text,steps:run.steps},null,2));
  console.log('PASS actual AI worker generated the branded newsletter, four-card grid, two CTAs and dark footer; template save/reload preserved the HTML.');
 }finally{
  if(customer)await db.deleteFrom('customers').where('id','=',customer.id).execute();
  if(user)await db.deleteFrom('users').where('id','=',user.id).execute();
  await closeQueues();await closeRedis().catch(()=>{});await closeDb();
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
