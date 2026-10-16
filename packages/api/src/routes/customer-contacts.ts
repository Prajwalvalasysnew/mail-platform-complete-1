import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {sql} from 'kysely';
import {addSuppression,recordAuditSafe,type TenantExecutor} from '@platform/shared';
import {requireScope} from '../plugins/scope.js';
import {tenantScoped} from '../lib/tenant.js';

const Contact=z.object({email:z.string().trim().email().max(320).transform(value=>value.toLowerCase()),name:z.string().trim().min(1).max(200),company:z.string().trim().max(200).default(''),location:z.string().trim().max(200).default(''),status:z.enum(['Pending','Subscribed','Unsubscribed']).default('Pending'),consent_confirmed:z.boolean().default(false)}).strict().refine(value=>value.status!=='Subscribed' || value.consent_confirmed,{message:'Documented consent must be confirmed before subscribing a contact.'});
const idsSchema=z.array(z.string().uuid()).min(1).max(200).refine(ids=>new Set(ids).size===ids.length);
const effectiveStatus=sql<string>`CASE WHEN s.reason IN ('hard_bounce','complaint','invalid') THEN 'Bounced' WHEN s.email IS NOT NULL THEN 'Unsubscribed' ELSE c.status END`;
async function insertContact(trx:TenantExecutor,customerId:string,input:z.infer<typeof Contact>,source:string){
  const suppression=await trx.selectFrom('suppressions').select('reason').where('customer_id','=',customerId).where('email','=',input.email).executeTakeFirst();
  if(suppression && input.status==='Subscribed')throw Object.assign(new Error('This address is suppressed. Creating a contact cannot bypass its suppression.'),{code:'suppressed_contact'});
  const row=await trx.insertInto('audience_contacts').values({customer_id:customerId,email:input.email,name:input.name,company:input.company,location:input.location,status:input.status,consent_confirmed_at:input.consent_confirmed?new Date():null,source}).returningAll().executeTakeFirstOrThrow();
  if(input.status==='Unsubscribed')await addSuppression(customerId,input.email,'unsubscribe','Unsubscribed in customer contacts',trx,{source:'customer_console'});
  return row;
}
export const customerContactRoutes:FastifyPluginAsync=async app=>{
  const scope=requireScope('contacts');
  app.get('/contacts',{preHandler:scope},async(req,reply)=>{
    const parsed=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(200).default(200)}).safeParse(req.query);
    if(!parsed.success)return reply.code(400).send({error:'validation_failed'});
    const cid=req.auth!.customer_id;
    return tenantScoped(req,async trx=>{
      const query=()=>trx.selectFrom('audience_contacts as c').leftJoin('suppressions as s',join=>join.onRef('s.email','=','c.email').onRef('s.customer_id','=','c.customer_id')).where('c.customer_id','=',cid);
      const contacts=await query().selectAll('c').select([effectiveStatus.as('effective_status'),sql<string[]>`ARRAY(SELECT a.name FROM audience_collection_members m JOIN audience_collections a ON a.id=m.collection_id AND a.customer_id=m.customer_id WHERE m.customer_id=c.customer_id AND m.contact_id=c.id ORDER BY a.name)`.as('list_names')]).orderBy('c.created_at','desc').orderBy('c.id','asc').offset(parsed.data.offset).limit(parsed.data.limit).execute();
      const stats=await query().select([sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE ${effectiveStatus}='Subscribed')::int`.as('subscribed'),sql<number>`count(*) FILTER(WHERE ${effectiveStatus}='Unsubscribed')::int`.as('unsubscribed'),sql<number>`count(*) FILTER(WHERE ${effectiveStatus}='Bounced')::int`.as('bounced'),sql<number>`count(*) FILTER(WHERE c.created_at >= date_trunc('month',now()))::int`.as('new_month')]).executeTakeFirstOrThrow();
      return {contacts,stats,next_offset:parsed.data.offset+contacts.length<stats.total?parsed.data.offset+contacts.length:null};
    });
  });
  app.post('/contacts',{preHandler:scope},async(req,reply)=>{
    const parsed=Contact.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'validation_failed',message:parsed.error.issues[0]?.message});
    try{
      const contact=await tenantScoped(req,trx=>insertContact(trx,req.auth!.customer_id,parsed.data,'Customer console'));
      recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'contact.created',resource:contact.id});
      return reply.code(201).send({contact});
    }catch(error:any){if(error.code==='23505')return reply.code(409).send({error:'contact_exists',message:'A contact with this email already exists.'});if(error.code==='suppressed_contact')return reply.code(409).send({error:error.code,message:error.message});throw error;}
  });
  app.post('/contacts/import',{preHandler:scope,bodyLimit:1500000},async(req,reply)=>{
    const parsed=z.object({contacts:z.array(Contact).min(1).max(200)}).strict().safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'validation_failed',message:'Provide up to 200 valid contacts per import. Subscribed contacts require confirmed consent.'});
    try{
      const imported=await tenantScoped(req,async trx=>{for(const contact of parsed.data.contacts)await insertContact(trx,req.auth!.customer_id,contact,'CSV import');return parsed.data.contacts.length;});
      recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user?.user_id,action:'contacts.imported',metadata:{count:imported}});
      return reply.code(201).send({imported});
    }catch(error:any){if(error.code==='23505')return reply.code(409).send({error:'contact_exists',message:'An email is duplicated or already exists. No contacts were imported.'});if(error.code==='suppressed_contact')return reply.code(409).send({error:error.code,message:error.message+' No contacts were imported.'});throw error;}
  });
  app.post('/contacts/bulk',{preHandler:scope},async(req,reply)=>{
    const parsed=z.object({ids:idsSchema,action:z.enum(['unsubscribe','delete'])}).strict().safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'validation_failed'});
    const cid=req.auth!.customer_id;
    const changed=await tenantScoped(req,async trx=>{
      const contacts=await trx.selectFrom('audience_contacts').select(['id','email']).where('customer_id','=',cid).where('id','in',parsed.data.ids).orderBy('id').forUpdate().execute();
      if(contacts.length!==parsed.data.ids.length)return null;
      if(parsed.data.action==='delete')await trx.deleteFrom('audience_contacts').where('customer_id','=',cid).where('id','in',parsed.data.ids).execute();
      else{
        for(const contact of contacts)await addSuppression(cid,contact.email,'unsubscribe','Unsubscribed in customer contacts',trx,{source:'customer_console'});
        await trx.updateTable('audience_contacts').set({status:'Unsubscribed',updated_at:new Date(),revision:sql`revision+1`}).where('customer_id','=',cid).where('id','in',parsed.data.ids).execute();
      }
      return contacts.length;
    });
    if(changed===null)return reply.code(404).send({error:'not_found'});
    recordAuditSafe({customerId:cid,actorType:'user',actorId:req.user?.user_id,action:`contacts.${parsed.data.action}`,metadata:{count:changed}});
    return {changed};
  });
};
