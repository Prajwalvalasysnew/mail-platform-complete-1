import { Queue } from 'bullmq';
import { redisOptions } from '../redis.js';

export interface AiJob { customer_id:string; run_id:string }
export const aiQueue = new Queue<AiJob>(`${process.env.QUEUE_PREFIX || ''}ai-writing`, {
  connection: { ...redisOptions, maxRetriesPerRequest:1, enableOfflineQueue:false, connectTimeout:2000 },
  defaultJobOptions: { attempts:1, removeOnComplete:{age:3600,count:1000}, removeOnFail:{age:3600,count:1000} },
});
aiQueue.on('error',()=>console.warn('[valasys-ai] queue connection unavailable'));

/** Reuse the logical run ID, reviving failed jobs only when DB authorizes dispatch. */
export async function enqueueAiRun(customerId:string,id:string) {
  const existing=await aiQueue.getJob(id);
  if(existing){
    const state=await existing.getState();
    if(state==='failed' || state==='completed')await existing.remove();
    else return;
  }
  await aiQueue.add('write',{customer_id:customerId,run_id:id},{jobId:id});
}
