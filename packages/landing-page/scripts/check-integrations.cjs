// Local Mailpit configuration only; exact UUID fixtures, no real delivery.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {db,registerOrgWithOwner,createUserSession,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
 if(process.env.NODE_ENV==='production' || process.env.DELIVERY_TRANSPORT!=='mailpit')throw new Error('This check requires the local Mailpit stack.');
 let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch('http://127.0.0.1:3000/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert.ok(ready,'API must be healthy before creating fixtures');
 const suffix=randomUUID().replaceAll('-',''),leadId=randomUUID(),fixtureIp=`198.18.${parseInt(suffix.slice(0,2),16)}.${parseInt(suffix.slice(2,4),16)}`;let owner;
 const call=async(path,body,token,method='POST')=>{const response=await fetch(`http://127.0.0.1:3000${path.startsWith('/admin/')?'':'/v1'}${path}`,{method,headers:{'Content-Type':'application/json','X-Forwarded-For':fixtureIp,...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 try{
  owner=await registerOrgWithOwner({email:`landing-integration-${suffix}@example.test`,password:randomUUID(),name:'Landing Integration'});
  const source=await createUserSession(owner.user.id,{mfaSatisfied:true,currentCustomerId:owner.customerId});
  const issued=await call('/auth/handoff',{destination:'onboarding'},source.token);assert.equal(issued.status,200);assert.match(issued.body.code,/^vmh_/);assert.equal(JSON.stringify(issued.body).includes(source.token),false);
  const inspect=await call('/auth/handoff/inspect',{code:issued.body.code});assert.equal(inspect.status,200);assert.equal(inspect.body.email,owner.user.email);assert.equal(inspect.body.destination,'onboarding');
  assert.equal((await call('/auth/handoff/redeem',{code:issued.body.code})).status,400,'Account confirmation is explicit');
  const outcomes=await Promise.all([call('/auth/handoff/redeem',{code:issued.body.code,confirmed:true}),call('/auth/handoff/redeem',{code:issued.body.code,confirmed:true})]);assert.equal(outcomes.filter(row=>row.status===200).length,1);assert.equal(outcomes.filter(row=>row.status===410).length,1);const redeemed=outcomes.find(row=>row.status===200).body;assert.equal(redeemed.mfa_required,false);
  assert.equal((await call('/auth/me',null,source.token,'GET')).status,401,'Old session token rotated');assert.equal((await call('/auth/me',null,redeemed.token,'GET')).status,200);assert.equal((await call('/auth/handoff/inspect',{code:issued.body.code})).status,410);
  const expired=await call('/auth/handoff',{destination:'workspace'},redeemed.token);await db.updateTable('workspace_handoffs').set({expires_at:new Date(Date.now()-1000)}).where('session_id','=',source.session_id).execute();assert.equal((await call('/auth/handoff/redeem',{code:expired.body.code,confirmed:true})).status,410);
  const revoked=await call('/auth/handoff',{destination:'workspace'},redeemed.token);await db.updateTable('user_sessions').set({revoked_at:new Date()}).where('id','=',source.session_id).execute();assert.equal((await call('/auth/handoff/redeem',{code:revoked.body.code,confirmed:true})).status,410);
  const pending=await createUserSession(owner.user.id,{mfaSatisfied:false,currentCustomerId:owner.customerId});await db.updateTable('users').set({mfa_enabled:true}).where('id','=',owner.user.id).execute();const mfaTicket=await call('/auth/handoff',{destination:'workspace'},pending.token),mfa=await call('/auth/handoff/redeem',{code:mfaTicket.body.code,confirmed:true});assert.equal(mfa.status,200);assert.equal(mfa.body.mfa_required,true);assert.equal((await call('/auth/me',null,mfa.body.token,'GET')).status,403);
  const disabled=await call('/auth/handoff',{destination:'workspace'},mfa.body.token);await db.updateTable('users').set({status:'disabled'}).where('id','=',owner.user.id).execute();assert.equal((await call('/auth/handoff/redeem',{code:disabled.body.code,confirmed:true})).status,410);
  console.log('PASS explicit single-use handoff, concurrent redemption, token rotation, expiry/revocation and preserved MFA');
  const sales={request_id:leadId,first_name:'Dummy',last_name:'Integration',email:`sales-${suffix}@example.test`,company:'Local Landing QA',monthly_volume:'Under 100,000',message:'Dummy sales integration check.',consent_confirmed:true};
  assert.equal((await call('/landing/sales-requests',sales)).status,201);assert.equal((await call('/landing/sales-requests',sales)).status,200);assert.equal((await call('/landing/sales-requests',{...sales,company:'Different'})).status,409);assert.equal((await call('/landing/sales-requests',{...sales,consent_confirmed:false})).status,400);
  const stored=await db.selectFrom('landing_sales_requests').selectAll().where('id','=',leadId).execute();assert.equal(stored.length,1);assert.equal(stored[0].email,sales.email);assert.equal(stored[0].company,sales.company);assert.ok(stored[0].consent_confirmed_at);assert.equal((await call('/admin/landing/sales-requests',null,null,'GET')).status,401);
  console.log('PASS persisted sales intake, consent validation, duplicate replay/conflict protection and admin-only listing');
 }finally{
  try{await db.deleteFrom('landing_sales_requests').where('id','=',leadId).where('email','=',`sales-${suffix}@example.test`).execute();if(owner){await db.deleteFrom('customers').where('id','=',owner.customerId).execute();await db.deleteFrom('users').where('id','=',owner.user.id).execute();}}finally{await closeQueues();await closeRedis();await db.destroy();}
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
