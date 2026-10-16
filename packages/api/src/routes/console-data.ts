import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { db, recordAuditSafe, type Capability } from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';
import { analyticsRoutes } from './analytics.js';
import { dmarcRoutes } from './dmarc.js';
import { messageRoutes } from './messages.js';
import { suppressionRoutes } from './suppressions.js';
import { templateRoutes } from './templates.js';
import { usageRoutes } from './usage.js';
import { workflowRoutes } from './workflows.js';
import { sendRoutes } from './send.js';
import { z } from 'zod';
import {customerContactRoutes} from './customer-contacts.js';
import {customerAudienceRoutes} from './customer-audiences.js';
import {customerWorkflowBuilderRoutes} from './customer-workflow-builder.js';
import {customerCampaignRoutes} from './customer-campaigns.js';

/**
 * Adapts the human console session to the existing tenant-scoped service
 * routes. The public API remains API-key-only; these copies live exclusively
 * below /v1/account/data and retain capability checks for every request.
 */
async function attachConsoleContext(
  req: FastifyRequest,
  reply: FastifyReply,
  capability: Capability,
  scopes: string[]
) {
  await requireCapability(capability)(req, reply);
  if (reply.sent || !req.user?.current_customer_id) return;

  const customer = await db
    .selectFrom('customers')
    .select(['tier', 'status', 'email_verified_at'])
    .where('id', '=', req.user.current_customer_id)
    .executeTakeFirst();
  if (!customer || customer.status !== 'active') {
    return reply.code(403).send({ error: 'account_suspended', message: 'Account is not active' });
  }

  req.auth = {
    customer_id: req.user.current_customer_id,
    // Session ids are UUIDs and provide request attribution for service code
    // that expects the API auth shape. No API key is created or disclosed.
    api_key_id: req.user.session_id,
    tier: customer.tier,
    scopes,
    test_mode: false,
    email_verified: customer.email_verified_at != null,
  };
}

async function registerBridge(
  app: FastifyInstance,
  capability: Capability,
  scopes: string[],
  plugins: FastifyPluginAsync[],
  writeCapability?: Capability
) {
  await app.register(async (instance) => {
    instance.addHook('preHandler', (req, reply) =>
      attachConsoleContext(req, reply, req.method === 'GET' ? capability : (writeCapability ?? capability), scopes)
    );
    for (const plugin of plugins) await instance.register(plugin);
  });
}

export const consoleDataRoutes: FastifyPluginAsync = async (app) => {
  await registerBridge(app,'logs:read',['contacts'],[customerContactRoutes,customerAudienceRoutes],'send');
  await registerBridge(app,'logs:read',['send'],[customerCampaignRoutes],'send');
  app.get('/profile', { preHandler:(req,reply)=>attachConsoleContext(req,reply,'logs:read',[]) }, async req=>{
    const customer=await db.selectFrom('customers')
      .select(['id','name','email','email_verified_at','physical_address','tier','daily_quota','monthly_quota','billing_status','status','tls_required','created_at'])
      .where('id','=',req.auth!.customer_id).executeTakeFirstOrThrow();
    return {customer};
  });
  app.patch('/profile', { preHandler:(req,reply)=>attachConsoleContext(req,reply,'settings:manage',[]) }, async(req,reply)=>{
    const parsed=z.object({name:z.string().trim().min(1).max(200).optional(),physical_address:z.string().min(5).max(500).nullable().optional()}).strict().safeParse(req.body);
    if(!parsed.success || !Object.keys(parsed.data).length)return reply.code(400).send({error:'validation_failed'});
    await db.updateTable('customers').set(parsed.data).where('id','=',req.auth!.customer_id).execute();
    recordAuditSafe({customerId:req.auth!.customer_id,actorType:'user',actorId:req.user!.user_id,actorLabel:req.user!.email,action:'profile.updated',metadata:{fields:Object.keys(parsed.data)},ip:req.ip});
    return {ok:true};
  });
  await registerBridge(app, 'logs:read', ['messages'], [analyticsRoutes, usageRoutes, messageRoutes], 'send');
  await registerBridge(app, 'send', ['templates'], [templateRoutes]);
  await registerBridge(app, 'send', ['workflows'], [customerWorkflowBuilderRoutes,workflowRoutes]);
  await registerBridge(app, 'domains:manage', ['domains'], [dmarcRoutes]);
  await registerBridge(app, 'settings:manage', ['suppressions'], [suppressionRoutes]);
  await registerBridge(app, 'send', ['send'], [sendRoutes]);
};
