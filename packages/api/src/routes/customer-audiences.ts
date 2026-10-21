import type {FastifyPluginAsync} from 'fastify';
import {sql} from 'kysely';
import {z} from 'zod';
import {recordAuditSafe,enrollAudienceWorkflows,kickWorkflowRun,type TenantExecutor} from '@platform/shared';
import {tenantScoped} from '../lib/tenant.js';

const Rule=z.object({field:z.enum(['Created','Opened any email','Clicked any email']),op:z.enum(['in last','not in last']),val:z.enum(['7 days','30 days','60 days','90 days','120 days'])}).strict();
const Input=z.object({kind:z.enum(['list','segment']),name:z.string().trim().min(1).max(200),rules:z.array(Rule).max(20).default([])}).strict().refine(value=>value.kind==='list'?value.rules.length===0:value.rules.length>0,'A segment needs at least one supported rule; lists have no rules.');
export function audienceMembers(trx:TenantExecutor,cid:string,collection:any){
 let query=trx.selectFrom('audience_contacts as c').where('c.customer_id','=',cid);
 if(collection.kind==='list')query=query.where(eb=>eb.exists(eb.selectFrom('audience_collection_members as m').select('m.contact_id').whereRef('m.contact_id','=','c.id').where('m.customer_id','=',cid).where('m.collection_id','=',collection.id)));
 else for(const rule of z.array(Rule).parse(collection.rules)){
   const days=Number(rule.val.split(' ')[0]),since=new Date(Date.now()-days*86400000);
   if(rule.field==='Created')query=query.where('c.created_at',rule.op==='in last'?'>=':'<',since);
   else query=query.where(sql<boolean>`${rule.op==='not in last'?sql`NOT`:sql``} EXISTS (SELECT 1 FROM messages m JOIN events e ON e.customer_id=m.customer_id AND e.message_id=m.message_id WHERE m.customer_id=${cid} AND m.to_address=c.email AND e.event_type=${rule.field==='Opened any email'?'opened':'clicked'} AND e.occurred_at>=${since})`);
 }
 return query;
}
export const customerAudienceRoutes:FastifyPluginAsync=async app=>{
 app.get('/audiences',async req=>tenantScoped(req,async trx=>{
   const rows=await trx.selectFrom('audience_collections').selectAll().where('customer_id','=',req.auth!.customer_id).orderBy('created_at','desc').limit(200).execute();
   const collections=[];for(const row of rows){const count=await audienceMembers(trx,req.auth!.customer_id,row).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();collections.push({...row,count:count.n});}
   return {collections};
 }));
 app.post('/audiences',async(req,reply)=>{
   const parsed=Input.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'validation_failed',message:'Use supported engagement/creation rules. Lists must have no rules.'});
   try{const row=await tenantScoped(req,trx=>trx.insertInto('audience_collections').values({customer_id:req.auth!.customer_id,...parsed.data,rules:sql<unknown[]>`${JSON.stringify(parsed.data.rules)}::jsonb`}).returningAll().executeTakeFirstOrThrow());recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'audience.created',resource:row.id});return reply.code(201).send(row);}catch(error:any){if(error.code==='23505')return reply.code(409).send({error:'name_exists',message:'An audience with this name already exists.'});throw error;}
 });
 app.get('/audiences/:id/members',async(req,reply)=>{
   const id=z.string().uuid().safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'validation_failed'});
   const result=await tenantScoped(req,async trx=>{const row=await trx.selectFrom('audience_collections').selectAll().where('id','=',id.data).where('customer_id','=',req.auth!.customer_id).executeTakeFirst();return row?{contacts:await audienceMembers(trx,req.auth!.customer_id,row).selectAll('c').orderBy('c.created_at','desc').limit(200).execute()}:null;});
   return result || reply.code(404).send({error:'not_found'});
 });
 app.post('/audiences/:id/members',async(req,reply)=>{
   const parsed=z.object({ids:z.array(z.string().uuid()).min(1).max(200).refine(ids=>new Set(ids).size===ids.length),action:z.enum(['add','remove'])}).strict().safeParse(req.body),id=z.string().uuid().safeParse((req.params as any).id);
   if(!parsed.success || !id.success)return reply.code(400).send({error:'validation_failed'});
   const cid=req.auth!.customer_id;
   const result=await tenantScoped(req,async trx=>{
     const collection=await trx.selectFrom('audience_collections').select('id').where('customer_id','=',cid).where('id','=',id.data).where('kind','=','list').forUpdate().executeTakeFirst();if(!collection)return null;
     const contacts=await trx.selectFrom('audience_contacts').select('id').where('customer_id','=',cid).where('id','in',parsed.data.ids).execute();if(contacts.length!==parsed.data.ids.length)return null;
     let runs:string[]=[];
     if(parsed.data.action==='add'){
      const added=await trx.insertInto('audience_collection_members').values(parsed.data.ids.map(contact_id=>({customer_id:cid,collection_id:id.data,contact_id}))).onConflict(oc=>oc.columns(['customer_id','collection_id','contact_id']).doNothing()).returning('contact_id').execute();
      // Newly added members enter workflows triggered by this list.
      if(added.length){const emails=await trx.selectFrom('audience_contacts').select('email').where('customer_id','=',cid).where('id','in',added.map(a=>a.contact_id)).where('status','!=','Unsubscribed').execute();runs=await enrollAudienceWorkflows(cid,id.data,emails.map(e=>e.email),trx as any);}
     }
     else await trx.deleteFrom('audience_collection_members').where('customer_id','=',cid).where('collection_id','=',id.data).where('contact_id','in',parsed.data.ids).execute();
     await trx.updateTable('audience_collections').set({updated_at:new Date()}).where('customer_id','=',cid).where('id','=',id.data).execute();return {processed:contacts.length,runs};
   });
   if(!result)return reply.code(404).send({error:'not_found'});
   for(const run of result.runs)await kickWorkflowRun(run,cid).catch(()=>undefined);recordAuditSafe({customerId:cid,actorType:'user',actorId:req.user?.user_id,action:`audience.members.${parsed.data.action}`,resource:id.data,metadata:{count:result.processed}});return {processed:result.processed,enrolled:result.runs.length};
 });
 app.delete('/audiences/:id',async(req,reply)=>{
   const id=z.string().uuid().safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'validation_failed'});
   const row=await tenantScoped(req,trx=>trx.deleteFrom('audience_collections').where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).returning('id').executeTakeFirst());if(!row)return reply.code(404).send({error:'not_found'});
   recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'audience.deleted',resource:row.id});return {deleted:true};
 });
};
