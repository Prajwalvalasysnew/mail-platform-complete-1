// Recovery for interrupted check-customer-integrations.cjs runs. Local dummy data only.
const {db,getPool,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
 try {
  if(process.env.NODE_ENV==='production'||process.env.DELIVERY_TRANSPORT!=='mailpit')throw new Error('Local Mailpit configuration required');
  const rows=await db.selectFrom('users').select(['id','email']).where('name','=','Reliability Integration').execute();
  const fixtures=rows.filter(row=>/^integration-[0-9a-f]{32}-[ab]@example\.test$/.test(row.email));
  for(const user of fixtures){
   const memberships=await db.selectFrom('memberships').innerJoin('customers','customers.id','memberships.customer_id').select(['customers.id','customers.name','memberships.role']).where('memberships.user_id','=',user.id).execute();
   const owned=memberships.filter(row=>row.role==='owner'&&row.name==='Reliability Integration');
   console.log(JSON.stringify({user:user.id,email:user.email,customers:owned.map(row=>row.id)}));
   if(!process.argv.includes('--apply'))continue;
   for(const customer of owned){
    for(const table of ['events','send_outbox','messages'])await db.deleteFrom(table).where('customer_id','=',customer.id).execute();
    await db.deleteFrom('customers').where('id','=',customer.id).execute();
   }
   await db.deleteFrom('users').where('id','=',user.id).execute();
   const role=`integration_rls_${user.email.split('-')[1]}`;
   const exists=await getPool().query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
   if(exists.rowCount){await getPool().query(`REVOKE ALL ON audience_collections,audience_collection_members,customer_campaigns FROM ${role}`);await getPool().query(`DROP ROLE ${role}`);}
  }
 }finally{await closeQueues();await closeRedis();await db.destroy();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
