const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {db,getPool,registerOrgWithOwner,createUser,addMembership,createUserSession,addSuppression,isSuppressed,invalidateSuppressionCache,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
  const suffix=randomUUID().replaceAll('-',''),emails=[],customers=[],users=[];
  const role=`ui_contacts_rls_${suffix}`;let roleCreated=false;
  async function call(token,path='',method='GET',body){const response=await fetch(`http://127.0.0.1:3000/v1/account/data/contacts${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
  try{
    const tokens=[];
    for(const name of ['a','b']){
      const email=`ui-contact-isolation-${suffix}-${name}@example.test`;emails.push(email);
      const registered=await registerOrgWithOwner({email,name:'Contact isolation',password:randomUUID()});customers.push(registered.customerId);users.push(registered.user.id);
      tokens.push((await createUserSession(registered.user.id,{mfaSatisfied:true,currentCustomerId:registered.customerId})).token);
    }
    const [a,b]=tokens;
    const email=`recipient-${suffix}@example.test`;
    const created=await call(a,'','POST',{email,name:'Contact A'});assert.equal(created.status,201);const id=created.body.contact.id;
    assert.equal((await call(b)).body.stats.total,0);
    assert.equal((await call(a,'','POST',{email:`consent-${suffix}@example.test`,name:'No evidence',status:'Subscribed'})).status,400);
    assert.equal((await call(a,'','POST',{email:email.toUpperCase(),name:'Duplicate'})).status,409);
    const own=await call(b,'','POST',{email,name:'Contact B'});assert.equal(own.status,201);
    assert.equal((await call(b,'/bulk','POST',{ids:[own.body.contact.id,id],action:'delete'})).status,404);
    assert.equal((await call(b)).body.stats.total,1,'A mixed-tenant bulk request is atomic');
    const analystEmail=`ui-contact-isolation-${suffix}-analyst@example.test`;emails.push(analystEmail);const analyst=await createUser({email:analystEmail,name:'Contact isolation analyst'});users.push(analyst.id);
    await addMembership(analyst.id,customers[0],'analyst');const analystToken=(await createUserSession(analyst.id,{mfaSatisfied:true,currentCustomerId:customers[0]})).token;
    assert.equal((await call(analystToken)).status,200);assert.equal((await call(analystToken,'','POST',{email:`denied-${suffix}@example.test`,name:'Denied'})).status,403);
    const blocked=`suppressed-${suffix}@example.test`;
    await addSuppression(customers[0],blocked,'hard_bounce');
    assert.equal((await call(a,'','POST',{email:blocked,name:'Must not bypass',status:'Subscribed',consent_confirmed:true})).status,409);
    const writes=await Promise.all([1,2].map(()=>call(a,'','POST',{email:`concurrent-${suffix}@example.test`,name:'Concurrent'})));
    assert.deepEqual(writes.map(result=>result.status).sort(),[201,409]);
    assert.equal((await call(a,'/bulk','POST',{ids:[id],action:'unsubscribe'})).status,200);assert.equal(await isSuppressed(customers[0],email),true);
    assert.equal((await call(a,'/bulk','POST',{ids:[id],action:'delete'})).status,200);assert.equal(await isSuppressed(customers[0],email),true,'Deleting a contact cannot remove an opt-out');
    const client=await getPool().connect();
    try{
      await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`);roleCreated=true;await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await client.query(`GRANT SELECT ON audience_contacts TO ${role}`);
      await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
      for(const [tenant,expected] of [[customers[0],1],[customers[1],1],['',0]]){await client.query("SELECT set_config('app.customer_id',$1,true)",[tenant]);assert.equal((await client.query('SELECT count(*)::int AS count FROM audience_contacts')).rows[0].count,expected);}
      await client.query('ROLLBACK');
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
    for(const cid of customers){await invalidateSuppressionCache(cid,email);await invalidateSuppressionCache(cid,blocked);}
    console.log('PASS contact tenant isolation, read-only RBAC, consent guards, suppression safety, concurrent duplicates, atomic bulk writes and forced database RLS');
  }finally{
    if(customers.length)await db.deleteFrom('customers').where('id','in',customers).where('email','in',emails).execute();
    if(users.length)await db.deleteFrom('users').where('id','in',users).where('email','in',emails).execute();
    if(roleCreated){await getPool().query(`REVOKE SELECT ON audience_contacts FROM ${role}`);await getPool().query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);await getPool().query(`DROP ROLE ${role}`);}
    await closeQueues();await closeRedis();await db.destroy();
  }
}
main().catch(error=>{console.error(error.message,error.cause?.code || '');process.exitCode=1;});
