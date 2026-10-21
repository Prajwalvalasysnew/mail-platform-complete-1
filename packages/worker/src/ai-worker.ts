// Separate entry point: AI never runs in the mail worker process.
import { createServer } from 'node:http';
import { Worker } from 'bullmq';
import { aiConfig, aiEnabledFor, aiQueue, enqueueAiRun, executeAiRun, maintainAiRuns, aiTenantPage, redisOptions, closeDb, closeQueues, closeRedis, rlsIsEnforced } from '@platform/shared';

const config=aiConfig();
if(!config.enabled)throw new Error('Set AI_ENABLED=true and trusted inference settings before starting the AI worker');
if(process.env.NODE_ENV==='production' && !await rlsIsEnforced())throw new Error('AI worker requires a non-bypass tenant database role and migration 105');
const shutdown=new AbortController();
await aiQueue.setGlobalConcurrency(config.concurrency);
const worker=new Worker(aiQueue.name,job=>executeAiRun(job.data.customer_id,job.data.run_id,shutdown.signal),{
  connection:redisOptions,concurrency:config.concurrency,lockDuration:30000,maxStalledCount:1,
});
worker.on('error',()=>console.error('[ai-worker] queue unavailable'));
worker.on('failed',job=>console.warn('[ai-worker] job interrupted',{run_id:job?.data.run_id}));
let sweeping=false,readyAt=0;
async function sweep(){
  if(sweeping || shutdown.signal.aborted)return;sweeping=true;
  try{
    let after='00000000-0000-0000-0000-000000000000';
    for(;;){
      const tenants=await aiTenantPage(after);
      for(const tenant of tenants){
        if(shutdown.signal.aborted)return;
        const pending=await maintainAiRuns(tenant.id);
        if(aiEnabledFor(tenant.id))for(const id of pending)await enqueueAiRun(tenant.id,id);
      }
      // A successful batch proves maintenance is progressing, even across large workspaces.
    readyAt=Date.now();
    if(tenants.length<100)break;
      after=tenants[tenants.length-1]!.id;
    }
    readyAt=Date.now();
  }catch{console.error('[ai-worker] dispatch maintenance failed');}
  finally{sweeping=false;}
}
const interval=setInterval(()=>void sweep(),5000);
void sweep();
const health=createServer((req,res)=>{
  if(!['/live','/health'].includes(req.url || '')){res.writeHead(404).end();return;}
  const ok=req.url==='/live' || (!shutdown.signal.aborted && Date.now()-readyAt<60000);
  res.writeHead(ok?200:503,{'Content-Type':'application/json'}).end(JSON.stringify({status:ok?'ok':'unavailable',service:'valasys-ai'}));
});
health.listen(Number(process.env.AI_HEALTH_PORT || 9103),'0.0.0.0');
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;clearInterval(interval);shutdown.abort();health.close();
  await worker.close();await aiQueue.close();await closeQueues();await closeRedis();await closeDb();
}
process.on('SIGTERM',()=>void stop().catch(()=>{process.exitCode=1;}));
process.on('SIGINT',()=>void stop().catch(()=>{process.exitCode=1;}));
