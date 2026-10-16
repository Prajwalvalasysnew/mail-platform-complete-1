// Only deletes this suite's UUID-named synthetic accounts, never real users.
const {db,closeQueues,closeRedis,invalidateSuppressionCache,workflowQueue}=require('/app/packages/shared/dist/index.js');
async function main(){
  const emails=process.argv.slice(2);
  if(!emails.length || emails.length>5 || emails.some(email=>!/^ui-reliability-[0-9a-f-]+@example\.test$/.test(email)))throw new Error('Cleanup requires exact reliability fixture emails.');
  try{
    const customers=await db.selectFrom('customers').select('id').where('email','in',emails).where('name','like','Reliability%').execute();
    for(const customer of customers){
      const contacts=await db.selectFrom('audience_contacts').select('email').where('customer_id','=',customer.id).execute();
      const runs=await db.selectFrom('workflow_runs').select(['id','steps_executed']).where('customer_id','=',customer.id).execute();
      for(const run of runs)for(let seq=0;seq<=Math.min(run.steps_executed+1,101);seq++)for(const kind of ['advance','wake','timeout']){const job=await workflowQueue.getJob(`wf-${kind}-${run.id}-${seq}`);if(job?.data.customer_id===customer.id)await job.remove().catch(()=>{});}
      await db.deleteFrom('customers').where('id','=',customer.id).where('email','in',emails).where('name','like','Reliability%').execute();
      for(const contact of contacts)await invalidateSuppressionCache(customer.id,contact.email);
    }
    await db.deleteFrom('users').where('email','in',emails).where('name','like','Reliability%').execute();
    console.log(`Cleaned ${customers.length} synthetic reliability workspaces.`);
  }finally{await closeQueues();await closeRedis();await db.destroy();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
