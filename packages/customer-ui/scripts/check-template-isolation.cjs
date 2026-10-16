// Runs inside the diagnostic API container; credentials stay in its environment.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {db,getPool,createCustomerApiKey,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    try{ready=(await fetch('http://127.0.0.1:3000/health')).ok;if(ready)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(ready,'Diagnostic API must be ready before creating temporary fixtures');
  const ids=[];const suffix=randomUUID().replaceAll('-','');
  const role=`ui_template_rls_${suffix}`;
  let roleCreated=false,template;
  const endpoint='http://127.0.0.1:3000/v1/templates';
  async function call(key,path='',method='GET',data){
    const response=await fetch(endpoint+path,{method,headers:{Authorization:`Bearer ${key}`,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:response.status,body:response.status===204?null:await response.json()};
  }
  try{
    for(const name of ['A','B']){
      const customer=await db.insertInto('customers').values({email:`ui-template-isolation-${suffix}-${name.toLowerCase()}@example.test`,name:`Template isolation ${name}`,status:'active'}).returning('id').executeTakeFirstOrThrow();
      ids.push(customer.id);
    }
    const [a,b]=await Promise.all(ids.map(customerId=>createCustomerApiKey({customerId,name:'Temporary isolation key',scopes:['templates']})));
    for(const path of ['/not-a-uuid','/not-a-uuid/versions','/not-a-uuid/versions/1'])assert.equal((await call(a.api_key,path)).status,400,'Malformed template ids fail validation, not a database error');
    const created=await call(a.api_key,'','POST',{name:'Isolation template',subject:'Private A',html_body:'<p>A only</p>',editor_document:{schemaVersion:1,project:{pages:[]}}});
    assert.equal(created.status,201);template=created.body.id;
    assert.equal((await call(b.api_key,`/${template}`)).status,404);
    assert.equal((await call(b.api_key,`/${template}/versions`)).status,404);
    assert.equal((await call(b.api_key,`/${template}/versions/1`)).status,404);
    assert.equal((await call(b.api_key,`/${template}`,'PUT',{name:'Attempted overwrite',subject:'Wrong tenant',html_body:'<p>B</p>',expected_revision:1})).status,404);
    assert.equal((await call(b.api_key,`/${template}`,'DELETE')).status,204);
    const original=await call(a.api_key,`/${template}`);
    assert.equal(original.body.subject,'Private A');assert.equal(original.body.revision,1);
    const writes=await Promise.all(['One','Two'].map(subject=>call(a.api_key,`/${template}`,'PUT',{name:'Isolation template',subject,html_body:'<p>Updated</p>',expected_revision:1})));
    assert.deepEqual(writes.map(result=>result.status).sort(),[200,409]);
    const versions=await call(a.api_key,`/${template}/versions`);
    assert.equal(versions.body.versions.length,2);
    const oversized=await call(a.api_key,'','POST',{name:'Oversized editor',subject:'Reject',html_body:'<p>Reject</p>',editor_document:{text:'x'.repeat(1_048_577)}});
    assert.equal(oversized.status,400);
    const client=await getPool().connect();
    try{
      await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`);roleCreated=true;
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT ON template_versions TO ${role}`);
      await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
      for(const [tenant,expected] of [[ids[0],2],[ids[1],0],['',0]]){
        await client.query("SELECT set_config('app.customer_id',$1,true)",[tenant]);
        const result=await client.query('SELECT count(*)::int AS n FROM template_versions WHERE template_id=$1',[template]);
        assert.equal(result.rows[0].n,expected,'RLS must fail closed and isolate the version history');
      }
      await client.query('ROLLBACK');
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
    console.log('PASS tenant isolation, database RLS, concurrent saves, immutable history reads, and editor size limit');
  }finally{
    if(ids.length)await db.deleteFrom('customers').where('id','in',ids).where('email','like',`ui-template-isolation-${suffix}-%@example.test`).execute();
    if(roleCreated){await getPool().query(`REVOKE SELECT ON template_versions FROM ${role}`);await getPool().query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);await getPool().query(`DROP ROLE ${role}`);}
    await closeQueues();
    await closeRedis();
    await db.destroy();
  }
}
main().catch(error=>{console.error(error.message,error.cause?.code || '');process.exitCode=1;});
