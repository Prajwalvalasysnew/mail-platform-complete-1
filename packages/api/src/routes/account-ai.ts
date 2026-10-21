import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AiInput, AiRunError, aiContextCatalog, ChatTurn,createChatTurn,listAiChats,getAiChat,decideAiDraft,deleteAiChat, aiEnabledFor, createAiRun, getAiRun, cancelAiRun, enqueueAiRun, redis, withTenant } from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';

const Request=z.object({request_id:z.string().uuid(),input:AiInput.refine(input=>!['route','compact','assist','editor'].includes(input.operation))}).strict();
const Id=z.string().uuid();

/** Human-session plane only; never exposes inference credentials or raw provider errors. */
export const accountAiRoutes:FastifyPluginAsync=async app=>{
  app.addHook('preHandler',requireCapability('send'));
  app.get('/context',async req=>aiContextCatalog(req.user!.current_customer_id!));
  app.get('/capabilities',async req=>({enabled:aiEnabledFor(req.user!.current_customer_id!),operations:['subjects','rewrite','draft','chat']}));
  const chatError=(error:unknown,reply:any)=>{
    if(error instanceof AiRunError)return reply.code(error.status).send({error:error.code,message:error.message});
    app.log.error({code:'ai_chat_failed'},'AI conversation request failed');
    return reply.code(503).send({error:'ai_temporarily_unavailable',message:'Your conversation could not be updated. Retry the same request.'});
  };
  app.get('/chats',async req=>listAiChats(req.user!.current_customer_id!,req.user!.user_id));
  app.get('/chats/:id',async(req,reply)=>{const id=Id.safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'invalid_chat_id'});try{return await getAiChat(req.user!.current_customer_id!,req.user!.user_id,id.data,z.coerce.number().int().positive().max(2147483647).parse((req.query as any).before_seq || 2147483647));}catch(error){return chatError(error,reply);}});
  app.delete('/chats/:id',async(req,reply)=>{const id=Id.safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'invalid_chat_id'});try{return await deleteAiChat(req.user!.current_customer_id!,req.user!.user_id,id.data);}catch(error){return chatError(error,reply);}});
  app.post('/chats/:id/turns',{bodyLimit:16000},async(req,reply)=>{
    const id=Id.safeParse((req.params as any).id),body=ChatTurn.safeParse(req.body);
    if(!id.success || !body.success)return reply.code(400).send({error:'invalid_chat_request',message:'Keep your message and workspace instructions within the supported limits.'});
    const u=req.user!,cid=u.current_customer_id!;
    if(!aiEnabledFor(cid))return reply.code(403).send({error:'ai_disabled',message:'AI is disabled for this workspace.'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([redis.ping(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Queue unavailable')),2000);})]);
      const run=await createChatTurn(cid,u.user_id,u.session_id,id.data,body.data);
      void enqueueAiRun(cid,run.id).catch(()=>app.log.warn({run_id:run.id},'AI chat dispatch pending recovery'));
      return reply.code(202).send(run);
    }catch(error){return chatError(error,reply);}finally{clearTimeout(timer);}
  });
  app.post('/chats/:id/messages/:mid/decision',async(req,reply)=>{
    const ids=z.object({id:Id,mid:Id}).safeParse(req.params),body=z.object({decision:z.enum(['applied','skipped'])}).strict().safeParse(req.body);
    if(!ids.success || !body.success)return reply.code(400).send({error:'invalid_decision'});
    try{return await decideAiDraft(req.user!.current_customer_id!,req.user!.user_id,ids.data.id,ids.data.mid,body.data.decision);}catch(error){return chatError(error,reply);}
  });
  app.post('/generations',{bodyLimit:40000},async(req,reply)=>{
    const parsed=Request.safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_ai_request',message:'Add a valid writing brief or selected text within the supported limits.'});
    const user=req.user!,cid=user.current_customer_id!;
    if(!aiEnabledFor(cid))return reply.code(403).send({error:'ai_disabled',message:'Valasys AI is not enabled for this workspace.'});
    // Admission must fail closed when the queue cannot be reached. No long offline queue waits.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([redis.ping(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Queue unavailable')),2000);})]);}
    catch{return reply.code(503).send({error:'ai_temporarily_unavailable',message:'Valasys AI is temporarily unavailable. Please try again.'});}
    finally{clearTimeout(timer);}
    try{
      const run=await createAiRun(cid,user.user_id,user.session_id,parsed.data.request_id,parsed.data.input);
      // The durable dispatcher recovers lost enqueue; do not hold the request on Redis retries.
      void enqueueAiRun(cid,run.id).catch(()=>app.log.warn({run_id:run.id},'AI dispatch pending recovery'));
      return reply.code(202).send(run);
    }catch(error){
      if(error instanceof AiRunError)return reply.code(error.status).send({error:error.code,message:error.message});
      app.log.error({code:'ai_admission_failed'},'AI request admission failed');
      return reply.code(503).send({error:'ai_temporarily_unavailable',message:'Valasys AI could not accept this request. Retry using the same request ID.'});
    }
  });
  app.get('/runs/:id',async(req,reply)=>{
    const id=Id.safeParse((req.params as {id:string}).id);
    if(!id.success)return reply.code(400).send({error:'invalid_run_id'});
    if(!aiEnabledFor(req.user!.current_customer_id!))return reply.code(403).send({error:'ai_disabled',message:'Valasys AI is disabled for this workspace.'});
    const row=await getAiRun(req.user!.current_customer_id!,req.user!.user_id,id.data);
    return row || reply.code(404).send({error:'not_found',message:'This AI result is unavailable or has expired.'});
  });
  app.post('/runs/:id/cancel',async(req,reply)=>{
    const id=Id.safeParse((req.params as {id:string}).id);
    if(!id.success)return reply.code(400).send({error:'invalid_run_id'});
    const row=await cancelAiRun(req.user!.current_customer_id!,req.user!.user_id,id.data);
    return row || reply.code(404).send({error:'not_found'});
  });
  // Self-service content export/deletion applies to the caller's short-lived runs only.
  app.get('/runs',async req=>withTenant(req.user!.current_customer_id!,async trx=>({runs:await trx.selectFrom('ai_runs')
    .select(['id','status','result','warnings','created_at','expires_at']).where('customer_id','=',req.user!.current_customer_id!).where('user_id','=',req.user!.user_id)
    .where('expires_at','>',new Date()).orderBy('created_at','desc').limit(100).execute()})));
  app.delete('/runs/:id',async(req,reply)=>{
    const id=Id.safeParse((req.params as {id:string}).id);if(!id.success)return reply.code(400).send({error:'invalid_run_id'});
    return withTenant(req.user!.current_customer_id!,async trx=>{
      const hold=await trx.selectFrom('legal_holds').select('id').where('customer_id','=',req.user!.current_customer_id!).where('released_at','is',null).executeTakeFirst();
      const lock=await trx.selectFrom('regulatory_retention_locks').select('id').where('customer_id','=',req.user!.current_customer_id!).where('released_at','is',null).where('retain_until','>',new Date()).executeTakeFirst();
      if(hold || lock)return reply.code(409).send({error:'retention_hold',message:'Workspace retention policy prevents deleting this record.'});
      const target=await trx.selectFrom('ai_runs').select('chat_id').where('customer_id','=',req.user!.current_customer_id!).where('user_id','=',req.user!.user_id).where('id','=',id.data).executeTakeFirst();
      if(target?.chat_id)return reply.code(409).send({error:'delete_conversation',message:'Delete the conversation to erase its messages and context checkpoints together.'});
      const result=await trx.deleteFrom('ai_runs').where('customer_id','=',req.user!.current_customer_id!).where('user_id','=',req.user!.user_id).where('id','=',id.data).executeTakeFirst();
      return Number(result.numDeletedRows)?{deleted:true}:reply.code(404).send({error:'not_found'});
    });
  });
};
