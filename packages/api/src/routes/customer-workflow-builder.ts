import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {sql} from 'kysely';
import {publishWorkflow,updateWorkflow,invalidateWorkflowActivityCache,recordAuditSafe} from '@platform/shared';
import {tenantScoped} from '../lib/tenant.js';

const Id=z.string().uuid();
const GraphId=z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const Graph=z.object({
 nodes:z.array(z.object({id:GraphId,t:z.string().min(1).max(64),x:z.number().finite().optional(),y:z.number().finite().optional()}).passthrough()).min(1).max(100),
 edges:z.array(z.object({id:GraphId,from:GraphId,to:GraphId,port:z.string().min(1).max(32)}).passthrough()).max(300),
}).passthrough().superRefine((graph,ctx)=>{
 const ids=new Set(graph.nodes.map(node=>node.id));
 if(ids.size!==graph.nodes.length || new Set(graph.edges.map(edge=>edge.id)).size!==graph.edges.length)ctx.addIssue({code:'custom',message:'Graph IDs must be unique.'});
 if(graph.nodes.filter(node=>node.t==='trigger').length!==1 || !graph.nodes.some(node=>node.id==='trigger' && node.t==='trigger'))ctx.addIssue({code:'custom',message:'One trigger node is required.'});
 if(graph.edges.some(edge=>!ids.has(edge.from)||!ids.has(edge.to)||edge.to==='trigger'))ctx.addIssue({code:'custom',message:'Edges must reference existing steps and cannot target the trigger.'});
});
const Input=z.object({expected_revision:z.number().int().min(0),name:z.string().trim().min(1).max(200),document:z.object({graph:Graph,settings:z.record(z.unknown()).optional(),tkey:z.string().max(64).optional()}).passthrough()}).strict();
export const customerWorkflowBuilderRoutes:FastifyPluginAsync=async app=>{
 app.get('/workflows/:id/builder',async(req,reply)=>{
   const id=Id.safeParse((req.params as any).id);if(!id.success)return reply.code(400).send({error:'validation_failed'});
   const row=await tenantScoped(req,trx=>trx.selectFrom('workflows').select(['id','name','status','builder_document','builder_revision','updated_at']).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).executeTakeFirst());return row || reply.code(404).send({error:'not_found'});
 });
 app.put('/workflows/:id/builder',{bodyLimit:300000},async(req,reply)=>{
   const id=Id.safeParse((req.params as any).id),body=Input.safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed'});
   try{
   const row=await tenantScoped(req,trx=>trx.updateTable('workflows').set({name:body.data.name,builder_document:body.data.document,builder_revision:sql`builder_revision+1`}).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).where('builder_revision','=',body.data.expected_revision).where('status','!=','archived').returning(['id','builder_revision','updated_at']).executeTakeFirst());
   if(!row)return reply.code(409).send({error:'stale_revision',message:'This workflow changed or is unavailable. Reload before saving again.'});return row;
   }catch(error:any){if(error.code==='23505')return reply.code(409).send({error:'name_exists'});throw error;}
 });
 app.post('/workflows/:id/builder/publish',{bodyLimit:300000},async(req,reply)=>{
   const id=Id.safeParse((req.params as any).id),body=z.object({expected_revision:z.number().int().min(1),definition:z.unknown()}).strict().safeParse(req.body);if(!id.success || !body.success)return reply.code(400).send({error:'validation_failed'});
   try{
    const result=await tenantScoped(req,async trx=>{
      const row=await trx.selectFrom('workflows').select(['builder_revision']).where('customer_id','=',req.auth!.customer_id).where('id','=',id.data).where('status','!=','archived').forUpdate().executeTakeFirst();
      if(!row || row.builder_revision!==body.data.expected_revision)return null;
      await updateWorkflow(req.auth!.customer_id,id.data,{definition:body.data.definition},trx);
      const published=await publishWorkflow({customerId:req.auth!.customer_id,id:id.data},trx);
      const updated=await trx.updateTable('workflows').set({builder_revision:sql`builder_revision+1`}).where('id','=',id.data).where('customer_id','=',req.auth!.customer_id).returning('builder_revision').executeTakeFirstOrThrow();
      return {...published,...updated};
    });
    if(!result)return reply.code(409).send({error:'stale_revision',message:'Reload the latest workflow before publishing.'});
    await invalidateWorkflowActivityCache(req.auth!.customer_id);recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'workflow.builder.published',resource:id.data});return result;
   }catch(error:any){if(['invalid_definition','unknown_template','invalid_webhook_url','invalid_sender','archived','invalid_state','not_found'].includes(error.code))return reply.code(422).send({error:error.code,message:error.message,details:error.details});throw error;}
 });
};
