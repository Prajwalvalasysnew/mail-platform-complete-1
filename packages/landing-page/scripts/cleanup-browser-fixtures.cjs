const {db,closeQueues,closeRedis}=require('/app/packages/shared/dist/index.js');
async function main(){
 const email=process.argv[2];if(!/^landing-browser-[0-9a-f-]{36}@example\.test$/.test(email || ''))throw new Error('An exact synthetic landing browser email is required.');
 if(process.env.NODE_ENV==='production' || process.env.DELIVERY_TRANSPORT!=='mailpit')throw new Error('Local fixtures only.');
 try{
  await db.deleteFrom('landing_sales_requests').where('email','=',email).where('company','=','Landing Browser QA').execute();
  await db.deleteFrom('customers').where('email','=',email).where('name','like','Landing Browser%').execute();
  await db.deleteFrom('users').where('email','=',email).where('name','=','Landing Browser').execute();
  console.log('Cleaned exact synthetic landing browser fixtures.');
 }finally{await closeQueues();await closeRedis();await db.destroy();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
