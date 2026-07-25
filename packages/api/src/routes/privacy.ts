import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { removeSuppression, getBodyStore, clickhouseEnabled, purgeQueuedMessageData, assertNoActiveHold, LegalHoldError, placeLegalHold, releaseLegalHold, listLegalHolds, recipientHoldScope, eraseWorkflowDataForRecipient, erasedRecipientPseudonym, pseudonymizeErasedRecipient, getConsentHistory, createPrivacyCase, verifyPrivacyCaseIdentity, transitionPrivacyCase, extendPrivacyCase, attachPrivacyCaseArtifact, recordPrivacyCaseCommunication, listPrivacyCases, getPrivacyCaseWithEvents, PrivacyCaseError, restrictProcessing, releaseProcessingRestriction, listProcessingRestrictions, rectifyRecipient, recordObjection } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const DeleteSchema = z.object({
  recipient: z.string().email(),
  requested_by: z.string().max(200).optional(),
});

const PlaceHoldSchema = z.object({
  // 'customer' for a tenant-wide hold, or an email / 'recipient:<email>' for one recipient.
  scope: z.string().min(1).max(320),
  reason: z.string().min(1).max(1000),
});

/**
 * GDPR / CCPA data-subject deletion. Removes all messages, events, suppression
 * entries, and soft-bounce tracking for a given recipient under the calling
 * customer, and records an auditable deletion request. Scoped to the customer's
 * own data — a customer can only erase recipients in their own tenant.
 */
export const privacyRoutes: FastifyPluginAsync = async (app) => {
  app.post('/privacy/delete-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = DeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    const recipient = parsed.data.recipient.toLowerCase();

    // tenantScoped() opens the transaction with app.customer_id set for RLS,
    // which also serves as the erasure transaction itself.
    let result;
    try {
      result = await tenantScoped(req, async (trx) => {
      // Legal hold gate (gap analysis #19): if an active hold covers this
      // recipient (a tenant-wide 'customer' hold or a 'recipient:<email>' hold),
      // erasure is BLOCKED. Checked first, inside the transaction, before any
      // row is touched — so held data is never destroyed. Throws LegalHoldError,
      // translated to a 409 below.
      await assertNoActiveHold(auth.customer_id, recipient, trx);

      // Create subquery to select message_ids for the recipient
      const subquery = trx
        .selectFrom('messages')
        .select('message_id')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient);

      // Capture the offloaded body object keys for this recipient's messages
      // BEFORE we delete the rows. GDPR erasure must remove the body content
      // (which holds the recipient's PII) from object storage too — deleting only
      // the DB row would orphan the PII-bearing object in fs/s3 indefinitely.
      const keyRows = await trx
        .selectFrom('messages')
        .select('body_object_key')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .where('body_storage', '!=', 'inline')
        .where('body_object_key', 'is not', null)
        .execute();
      const candidateKeys = Array.from(new Set(keyRows.map((r) => r.body_object_key as string)));
      const messageRows = await trx.selectFrom('messages').select('message_id')
        .where('customer_id', '=', auth.customer_id).where('to_address', '=', recipient).execute();
      const messageIds = messageRows.map((row) => row.message_id);

      // Event rows and tracked links are keyed by message_id; delete them using the subquery
      const ev = await trx
        .deleteFrom('events')
        .where('customer_id', '=', auth.customer_id)
        .where('message_id', 'in', subquery)
        .executeTakeFirst();
      const eventsDeleted = Number(ev.numDeletedRows ?? 0);

      await trx
        .deleteFrom('tracked_links')
        .where('message_id', 'in', subquery)
        .execute();

      // Outbox rows were previously removed by the messages FK CASCADE; with
      // messages partitioned (migration 064) the FK is gone, so delete them
      // explicitly before the message rows.
      await trx
        .deleteFrom('send_outbox')
        .where('message_id', 'in', subquery)
        .execute();

      const msgDel = await trx
        .deleteFrom('messages')
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .executeTakeFirst();

      await trx
        .deleteFrom('soft_bounce_tracker')
        .where('customer_id', '=', auth.customer_id)
        .where('email', '=', recipient)
        .execute();

      // Workflow runs + step ledgers carry the recipient's email and journey
      // data; erase them in the same transaction (cancels in-flight journeys
      // as a side effect — their rows are simply gone).
      await eraseWorkflowDataForRecipient(auth.customer_id, recipient, trx);

      // Of the candidate keys, find which are STILL referenced by a surviving
      // message (bodies are content-addressed and deduped across recipients, so
      // a shared body must not be deleted while another message needs it).
      let orphanKeys: string[] = [];
      if (candidateKeys.length > 0) {
        const stillReferenced = await trx
          .selectFrom('messages')
          .select('body_object_key')
          .where('body_object_key', 'in', candidateKeys)
          .execute();
        const liveKeys = new Set(stillReferenced.map((r) => r.body_object_key as string));
        orphanKeys = candidateKeys.filter((k) => !liveKeys.has(k));
      }

      // BASE-03: the erasure evidence record itself must not retain the
      // direct identifier — store the keyed pseudonym from the start, so the
      // erasure never writes the plaintext address it is meant to remove.
      const pseudonym = erasedRecipientPseudonym(auth.customer_id, recipient);
      const log = await trx
        .insertInto('deletion_requests')
        .values({
          customer_id: auth.customer_id,
          recipient: pseudonym,
          pseudonymized_at: new Date(),
          requested_by: parsed.data.requested_by ?? null,
          messages_deleted: Number(msgDel.numDeletedRows ?? 0),
          events_deleted: eventsDeleted,
          status: 'pending',
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      if (orphanKeys.length > 0) {
        const storageKind = getBodyStore().kind;
        await trx.insertInto('deletion_object_items').values(
          orphanKeys.map((objectKey) => ({
            deletion_request_id: log.id,
            object_key: objectKey,
            storage_kind: storageKind,
          }))
        ).execute();
      }
      if (clickhouseEnabled() && messageIds.length > 0) {
        await trx.insertInto('deletion_object_items').values(messageIds.map((messageId) => ({
          deletion_request_id: log.id,
          object_key: messageId,
          storage_kind: 'clickhouse',
        }))).execute();
      }
      if (messageIds.length > 0) {
        await trx.insertInto('privacy_message_tombstones').values(messageIds.map((messageId) => ({
          customer_id: auth.customer_id,
          message_id: messageId,
          deletion_request_id: log.id,
        }))).onConflict((oc) => oc.columns(['customer_id', 'message_id']).doNothing()).execute();
        await trx.insertInto('deletion_object_items').values(messageIds.map((messageId) => ({
          deletion_request_id: log.id,
          object_key: messageId,
          storage_kind: 'bullmq',
        }))).execute();
      }

      // Suppression removal happens INSIDE the tenant transaction too now (it
      // touches the RLS-protected `suppressions` table), but the Redis cache
      // clear it performs is a separate side effect that is safe either way.
      await removeSuppression(auth.customer_id, recipient, trx, { source: 'gdpr_erasure', reason: 'erasure' });

      // BASE-03: strip the recipient's direct identifiers from the stores
      // that survive erasure — the consent ledger (including the unsuppress
      // row removeSuppression just appended), prior deletion requests, and
      // unsubscribe-group memberships. Runs last inside the transaction so
      // every plaintext row written above is covered.
      const pseudonymized = await pseudonymizeErasedRecipient(auth.customer_id, recipient, trx);

      return {
        pseudonymized,
        request_id: log.id,
        messages_deleted: Number(msgDel.numDeletedRows ?? 0),
        events_deleted: eventsDeleted,
        orphanKeys,
        messageIds,
      };
    });
    } catch (err) {
      // A recipient under an active legal hold cannot be erased. Return 409
      // Conflict with the blocking hold reasons, so the caller understands why.
      if (err instanceof LegalHoldError) {
        return reply.code(409).send({
          error: 'legal_hold_active',
          message: 'Erasure is blocked: the recipient is under an active legal hold.',
          holds: err.holds.map((h) => ({ id: h.id, scope: h.scope, reason: h.reason })),
        });
      }
      throw err;
    }

    // Delete orphaned body objects from the store AFTER the DB commit (so we
    // never delete an object that a rolled-back transaction would have kept).
    // Best-effort per key; a store failure is logged but does not fail the
    // erasure (the DB rows — the authoritative record — are already gone).
    const bodyStore = getBodyStore();
    let bodiesDeleted = 0;
    const failedObjects: Array<{ key: string; error: string }> = [];
    if (bodyStore.kind !== 'inline' && result.orphanKeys.length > 0) {
      for (const key of result.orphanKeys) {
        try {
          await bodyStore.delete(key);
          bodiesDeleted++;
          await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
            status: 'completed', attempts: 1, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null,
          }).where('deletion_request_id', '=', result.request_id).where('object_key', '=', key).execute());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failedObjects.push({ key, error: message });
          await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
            status: 'failed', attempts: 1, last_error: message.slice(0, 2000), updated_at: new Date().toISOString(),
          }).where('deletion_request_id', '=', result.request_id).where('object_key', '=', key).execute());
          req.log.warn({ err, key }, 'GDPR erasure: failed to delete body object');
        }
      }
    }

    for (const messageId of result.messageIds) {
      try {
        const queueResult = await purgeQueuedMessageData(messageId);
        if (queueResult.active > 0) throw new Error(`bullmq_active_jobs:${queueResult.active}`);
        await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
          status: 'completed', attempts: 1, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null,
        }).where('deletion_request_id', '=', result.request_id).where('storage_kind', '=', 'bullmq').where('object_key', '=', messageId).execute());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await tenantScoped(req, (trx) => trx.updateTable('deletion_object_items').set({
          status: 'failed', attempts: 1, last_error: message.slice(0, 2000), updated_at: new Date().toISOString(),
        }).where('deletion_request_id', '=', result.request_id).where('storage_kind', '=', 'bullmq').where('object_key', '=', messageId).execute());
        req.log.warn({ err, messageId }, 'GDPR erasure: failed to purge BullMQ payloads');
      }
    }

    const outstanding = await tenantScoped(req, (trx) => trx.selectFrom('deletion_object_items')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('deletion_request_id', '=', result.request_id)
      .where('status', '!=', 'completed').executeTakeFirstOrThrow());
    const finalStatus = Number(outstanding.count) === 0 ? 'completed' : 'pending';
    await tenantScoped(req, (trx) => trx.updateTable('deletion_requests')
      .set({ status: finalStatus })
      .where('id', '=', result.request_id)
      .where('customer_id', '=', auth.customer_id)
      .execute());

    return reply.code(finalStatus === 'completed' ? 200 : 202).send({
      recipient,
      status: finalStatus,
      request_id: result.request_id,
      messages_deleted: result.messages_deleted,
      events_deleted: result.events_deleted,
      bodies_deleted: bodiesDeleted,
      objects_pending: Number(outstanding.count),
      consent_events_pseudonymized: result.pseudonymized.consentEventsPseudonymized,
      group_memberships_deleted: result.pseudonymized.groupMembershipsDeleted,
    });
  });

  // List prior deletion requests (proof of compliance).
  app.get('/privacy/deletions', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('deletion_requests')
        .select(['id', 'recipient', 'messages_deleted', 'events_deleted', 'status', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute()
    );
    return { deletions: rows };
  });

  // GDPR Article 15 right-to-access: export all data held for a recipient.
  const ExportQuery = z.object({ email: z.string().email() });
  app.get('/privacy/export-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = ExportQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const recipient = parsed.data.email.toLowerCase();

    // BASE-02 (compliance implementation plan): the export must cover every
    // recipient-linked record class, not only messages/events/suppression —
    // tracked links, full consent history, unsubscribe-group memberships,
    // workflow journey data, soft-bounce state, and retained (pseudonymous)
    // erasure evidence are all returned below.
    const data = await tenantScoped(req, async (trx) => {
      const messages = await trx
        .selectFrom('messages')
        .select(['message_id', 'subject', 'status', 'queued_at', 'delivered_at', 'bounced_at', 'opened_at', 'first_clicked_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('to_address', '=', recipient)
        .orderBy('queued_at', 'desc')
        .limit(1000)
        .execute();

      const messageIds = messages.map((m) => m.message_id);
      const events = messageIds.length > 0
        ? await trx
            .selectFrom('events')
            .select(['id', 'message_id', 'event_type', 'occurred_at', 'ip', 'payload'])
            .where('customer_id', '=', auth.customer_id)
            .where('message_id', 'in', messageIds)
            .orderBy('occurred_at', 'desc')
            .limit(5000)
            .execute()
        : [];

      const suppression = await trx
        .selectFrom('suppressions')
        .select(['reason', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('email', '=', recipient)
        .executeTakeFirst();

      const trackedLinks = messageIds.length > 0
        ? await trx
            .selectFrom('tracked_links')
            .select(['message_id', 'original_url', 'label', 'created_at'])
            .where('message_id', 'in', messageIds)
            .orderBy('created_at', 'desc')
            .limit(5000)
            .execute()
        : [];

      const consentHistory = await getConsentHistory(auth.customer_id, recipient, trx, 1000);

      const groupMemberships = await trx
        .selectFrom('unsubscribe_group_members')
        .innerJoin('unsubscribe_groups', 'unsubscribe_groups.id', 'unsubscribe_group_members.group_id')
        .select(['unsubscribe_group_members.group_id', 'unsubscribe_groups.name as group_name', 'unsubscribe_group_members.unsubscribed_at'])
        .where('unsubscribe_group_members.customer_id', '=', auth.customer_id)
        .where('unsubscribe_group_members.email', '=', recipient)
        .execute();

      const workflowRuns = await trx
        .selectFrom('workflow_runs')
        .select(['id', 'workflow_id', 'version', 'status', 'trigger_source', 'steps_executed', 'started_at', 'finished_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('subject_email', '=', recipient)
        .orderBy('started_at', 'desc')
        .limit(1000)
        .execute();

      const softBounce = await trx
        .selectFrom('soft_bounce_tracker')
        .select(['count', 'first_seen', 'last_seen'])
        .where('customer_id', '=', auth.customer_id)
        .where('email', '=', recipient)
        .executeTakeFirst();

      // Retained erasure evidence: prior requests are stored under the keyed
      // pseudonym (BASE-03), so match both the plaintext (legacy rows) and
      // the recomputed pseudonym.
      const deletionRequests = await trx
        .selectFrom('deletion_requests')
        .select(['id', 'status', 'messages_deleted', 'events_deleted', 'pseudonymized_at', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .where('recipient', 'in', [recipient, erasedRecipientPseudonym(auth.customer_id, recipient)])
        .orderBy('created_at', 'desc')
        .execute();

      return { messages, events, suppression, trackedLinks, consentHistory, groupMemberships, workflowRuns, softBounce, deletionRequests };
    });

    return {
      recipient,
      exported_at: new Date().toISOString(),
      messages: data.messages,
      events: data.events,
      suppressed: data.suppression ? { reason: data.suppression.reason, since: data.suppression.created_at } : null,
      tracked_links: data.trackedLinks,
      consent_history: data.consentHistory,
      unsubscribe_group_memberships: data.groupMemberships,
      workflow_runs: data.workflowRuns,
      soft_bounce: data.softBounce ?? null,
      erasure_requests: data.deletionRequests,
    };
  });

  // ─── Privacy case management (BASE-05) ────────────────────────────────────
  // Data-subject requests as tracked cases with statutory deadlines, identity
  // verification, extension, denial/exception, artifacts, and closure
  // evidence. Errors from the shared state machine map to 4xx codes here.
  const CreateCaseSchema = z.object({
    subject_kind: z.enum(['recipient', 'account_user']).optional(),
    subject_identifier: z.string().min(3).max(320),
    intake_source: z.enum(['api', 'email', 'web_form', 'support', 'authorized_agent', 'postal']),
    request_types: z.array(z.enum(['access', 'erasure', 'rectification', 'restriction', 'objection', 'portability', 'opt_out', 'limit_sensitive_pi'])).min(1),
    jurisdiction: z.enum(['gdpr', 'ccpa', 'other', 'unknown']).optional(),
  });
  const caseErrorReply = (reply: any, err: unknown) => {
    if (err instanceof PrivacyCaseError) {
      const status = err.code === 'case_not_found' ? 404 : err.code === 'invalid_transition' ? 409 : 422;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    throw err;
  };

  // ─── GDPR-02 / CCPA-02: rights beyond access and erasure ─────────────────

  const RestrictSchema = z.object({
    recipient: z.string().email(),
    basis: z.enum(['accuracy_contested', 'unlawful_processing', 'legal_claims', 'objection_pending']),
    reason: z.string().max(1000).optional(),
    requested_by: z.string().max(200).optional(),
    privacy_case_id: z.string().uuid().optional(),
  });

  /**
   * Article 18: store it, do not use it. Deliberately NOT suppression — a
   * restriction is lifted by a decision, not by the recipient resubscribing.
   */
  app.post('/privacy/restrict-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = RestrictSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const result = await tenantScoped(req, (trx) => restrictProcessing({
      customerId: auth.customer_id,
      email: parsed.data.recipient,
      basis: parsed.data.basis,
      reason: parsed.data.reason ?? null,
      requestedBy: parsed.data.requested_by ?? null,
      privacyCaseId: parsed.data.privacy_case_id ?? null,
    }, trx));

    return reply.code(result.alreadyRestricted ? 200 : 201).send({
      restriction: result.restriction,
      already_restricted: result.alreadyRestricted,
    });
  });

  const ReleaseRestrictionSchema = z.object({
    recipient: z.string().email(),
    // Article 18(3) requires informing the data subject before lifting, so an
    // unexplained release is not a defensible record.
    reason: z.string().min(1).max(1000),
    released_by: z.string().max(200).optional(),
  });

  app.post('/privacy/release-restriction', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = ReleaseRestrictionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const released = await tenantScoped(req, (trx) => releaseProcessingRestriction({
      customerId: auth.customer_id,
      email: parsed.data.recipient,
      reason: parsed.data.reason,
      releasedBy: parsed.data.released_by ?? null,
    }, trx));
    if (!released) return reply.code(404).send({ error: 'not_found', message: 'No active restriction for that recipient.' });
    return { released: true };
  });

  app.get('/privacy/restrictions', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { include_released, limit } = req.query as Record<string, string | undefined>;
    const restrictions = await listProcessingRestrictions(auth.customer_id, {
      includeReleased: include_released === 'true',
      limit: limit ? Number(limit) : undefined,
    });
    return { restrictions };
  });

  const RectifySchema = z.object({
    recipient: z.string().email(),
    corrected: z.string().email(),
    requested_by: z.string().max(200).optional(),
  });

  /**
   * Article 16 / CCPA right to correct. Corrects the stores that govern FUTURE
   * processing; historical delivery records are preserved and reported, because
   * "we sent to X on date Y" is accurate and rewriting it would falsify a log.
   */
  app.post('/privacy/rectify-recipient', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = RectifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    if (parsed.data.recipient.toLowerCase() === parsed.data.corrected.toLowerCase()) {
      return reply.code(422).send({ error: 'rectify_noop', message: 'The corrected address is identical to the current one.' });
    }

    const result = await tenantScoped(req, (trx) => rectifyRecipient({
      customerId: auth.customer_id,
      from: parsed.data.recipient,
      to: parsed.data.corrected,
      requestedBy: parsed.data.requested_by ?? null,
    }, trx));

    return {
      ...result,
      note: 'Historical message and event records are preserved: they are an accurate record of what was sent, and rewriting them would falsify the delivery log rather than correct inaccurate data.',
    };
  });

  const ObjectSchema = z.object({
    recipient: z.string().email(),
    reason: z.string().max(1000).optional(),
    requested_by: z.string().max(200).optional(),
  });

  /**
   * Article 21(2): the right to object to direct marketing is unconditional —
   * no balancing test, no grace period — so it takes effect immediately.
   */
  app.post('/privacy/object', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = ObjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    await tenantScoped(req, (trx) => recordObjection({
      customerId: auth.customer_id,
      email: parsed.data.recipient,
      reason: parsed.data.reason ?? null,
      requestedBy: parsed.data.requested_by ?? null,
    }, trx));
    return reply.code(200).send({ objection_recorded: true, effective: 'immediately' });
  });

  app.post('/privacy/cases', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateCaseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const row = await tenantScoped(req, (trx) => createPrivacyCase({
      customerId: auth.customer_id,
      subjectKind: parsed.data.subject_kind,
      subjectIdentifier: parsed.data.subject_identifier,
      intakeSource: parsed.data.intake_source,
      requestTypes: parsed.data.request_types,
      jurisdiction: parsed.data.jurisdiction,
      createdBy: auth.api_key_id ?? 'api',
    }, trx));
    return reply.code(201).send({ case: row });
  });

  app.get('/privacy/cases', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { status, overdue, limit, offset } = req.query as Record<string, string | undefined>;
    const cases = await tenantScoped(req, (trx) => listPrivacyCases(auth.customer_id, {
      status: status as never,
      overdueOnly: overdue === 'true',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    }, trx));
    return { cases };
  });

  app.get('/privacy/cases/:id', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const row = await tenantScoped(req, (trx) => getPrivacyCaseWithEvents(auth.customer_id, id, trx));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { case: row };
  });

  const VerifySchema = z.object({ method: z.string().min(1).max(200) });
  app.post('/privacy/cases/:id/verify', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const row = await tenantScoped(req, (trx) =>
        verifyPrivacyCaseIdentity(auth.customer_id, id, parsed.data.method, auth.api_key_id ?? 'api', trx));
      return { case: row };
    } catch (err) { return caseErrorReply(reply, err); }
  });

  const TransitionSchema = z.object({
    status: z.enum(['verifying', 'in_progress', 'waiting_on_subject', 'fulfilled', 'denied', 'closed']),
    denial_reason: z.string().min(1).max(2000).optional(),
    approved_by: z.string().min(1).max(200).optional(),
  });
  app.post('/privacy/cases/:id/transition', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = TransitionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const row = await tenantScoped(req, (trx) => transitionPrivacyCase(auth.customer_id, id, parsed.data.status, {
        actor: auth.api_key_id ?? 'api',
        denialReason: parsed.data.denial_reason,
        approvedBy: parsed.data.approved_by,
      }, trx));
      return { case: row };
    } catch (err) { return caseErrorReply(reply, err); }
  });

  const ExtendSchema = z.object({ reason: z.string().min(1).max(2000) });
  app.post('/privacy/cases/:id/extend', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = ExtendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const row = await tenantScoped(req, (trx) =>
        extendPrivacyCase(auth.customer_id, id, parsed.data.reason, auth.api_key_id ?? 'api', trx));
      return { case: row };
    } catch (err) { return caseErrorReply(reply, err); }
  });

  const ArtifactSchema = z.object({
    kind: z.string().min(1).max(100),
    ref: z.string().min(1).max(500),
    note: z.string().max(1000).optional(),
  });
  app.post('/privacy/cases/:id/artifacts', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = ArtifactSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const row = await tenantScoped(req, (trx) =>
        attachPrivacyCaseArtifact(auth.customer_id, id, parsed.data, auth.api_key_id ?? 'api', trx));
      return { case: row };
    } catch (err) { return caseErrorReply(reply, err); }
  });

  const CommunicationSchema = z.object({
    direction: z.enum(['inbound', 'outbound']),
    channel: z.string().min(1).max(100),
    summary: z.string().max(1000).optional(),
  });
  app.post('/privacy/cases/:id/communications', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = CommunicationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      await tenantScoped(req, (trx) =>
        recordPrivacyCaseCommunication(auth.customer_id, id, parsed.data, auth.api_key_id ?? 'api', trx));
      return { recorded: true };
    } catch (err) { return caseErrorReply(reply, err); }
  });

  // ─── Legal holds (gap analysis #19) ────────────────────────────────────────
  // Place / list / release legal holds. A hold blocks erasure for its scope.
  // Requires the messages scope (same as erasure); a customer can only manage
  // holds on their own tenant.
  app.get('/privacy/legal-holds', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const { active } = req.query as { active?: string };
    const holds = await tenantScoped(req, (trx) =>
      listLegalHolds(auth.customer_id, { activeOnly: active === 'true' }, trx)
    );
    return { holds };
  });

  app.post('/privacy/legal-holds', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = PlaceHoldSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    // Normalize scope: a bare email becomes recipient:<email>; 'customer' stays.
    const scope = parsed.data.scope === 'customer'
      ? 'customer'
      : recipientHoldScope(parsed.data.scope.replace(/^recipient:/i, ''));
    const hold = await tenantScoped(req, (trx) =>
      placeLegalHold({ customerId: auth.customer_id, scope, reason: parsed.data.reason, createdBy: auth.api_key_id ?? 'api' }, trx)
    );
    return reply.code(201).send({ hold });
  });

  app.post('/privacy/legal-holds/:id/release', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const ok = await tenantScoped(req, (trx) => releaseLegalHold(auth.customer_id, id, auth.api_key_id ?? 'api', trx));
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { released: id };
  });
};
