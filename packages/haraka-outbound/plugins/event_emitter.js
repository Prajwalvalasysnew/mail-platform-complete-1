// Haraka plugin that publishes outbound delivery events to the events queue.
// Hooks: delivered, deferred (soft bounce), bounce (hard bounce).

const { Queue } = require('bullmq');
const crypto = require('node:crypto');

let eventsQueue;

exports.register = function () {
  const plugin = this;
  plugin.register_hook('init_master', 'init_queue');
  plugin.register_hook('init_child', 'init_queue');
  plugin.register_hook('delivered', 'on_delivered');
  plugin.register_hook('deferred', 'on_deferred');
  plugin.register_hook('bounce', 'on_bounce');
};

exports.init_queue = function (next) {
  try {
    const prefix = process.env.QUEUE_PREFIX || '';
    eventsQueue = new Queue(`${prefix}events`, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    });
    this.loginfo(`events queue connected (name=${prefix}events)`);
    next();
  } catch (err) {
    this.logerror(`failed to init events queue: ${err.message}`);
    next();
  }
};

function getMessageId(hmail) {
  // Stored in transaction notes by header_cleanup plugin before queueing
  return (hmail.todo && hmail.todo.notes && hmail.todo.notes.message_id) ||
         (hmail.notes && hmail.notes.message_id);
}

function getCustomerId(hmail) {
  return (hmail.todo && hmail.todo.notes && hmail.todo.notes.customer_id) ||
         (hmail.notes && hmail.notes.customer_id);
}

exports.on_delivered = function (next, hmail, params) {
  const messageId = getMessageId(hmail);
  if (!messageId || !eventsQueue) return next();

  const [host, ip, response, delay, port, mode, ok_recips, secured] = params;

  // Per-delivery transport-encryption evidence for TLS-required tenants
  // (HIPAA/PCI posture): record whether this hop was actually TLS-secured,
  // and log loudly when a require-TLS message went out in the clear.
  const notes = (hmail.todo && hmail.todo.notes) || hmail.notes || {};
  const tlsRequired = notes.require_tls === true;
  const tlsSecured = typeof secured === 'boolean' ? secured : null;
  if (tlsRequired && tlsSecured === false) {
    this.logerror(`TLS-REQUIRED VIOLATION: message ${messageId} delivered to ${host} without TLS`);
  }

  eventsQueue.add('delivered', {
    message_id: messageId,
    customer_id: getCustomerId(hmail),
    event_type: 'delivered',
    event_key: crypto.randomUUID(),
    payload: {
      smtp_host: host,
      smtp_ip: ip,
      smtp_response: response,
      delivery_delay_ms: delay,
      recipient_count: ok_recips ? ok_recips.length : 1,
      // Source IP Haraka used for this outbound connection (set by
      // outbound.src_ip config per pool). Null on shared-IP setups.
      src_ip: (hmail.todo && hmail.todo.src_ip) || null,
      tls_secured: tlsSecured,
      ...(tlsRequired ? { tls_required: true } : {}),
    },
    occurred_at: new Date().toISOString(),
  }).catch((err) => this.logerror(`failed to enqueue delivered: ${err.message}`));

  next();
};

exports.on_deferred = function (next, hmail, params) {
  const messageId = getMessageId(hmail);
  if (!messageId || !eventsQueue) return next();

  eventsQueue.add('soft_bounce', {
    message_id: messageId,
    customer_id: getCustomerId(hmail),
    event_type: 'soft_bounce',
    event_key: crypto.randomUUID(),
    payload: {
      reason: params && params.err ? String(params.err) : 'deferred',
      delay: params && params.delay,
    },
    occurred_at: new Date().toISOString(),
  }).catch((err) => this.logerror(`failed to enqueue deferred: ${err.message}`));

  next();
};

exports.on_bounce = function (next, hmail, error) {
  const messageId = getMessageId(hmail);
  if (!messageId || !eventsQueue) return next();

  eventsQueue.add('hard_bounce', {
    message_id: messageId,
    customer_id: getCustomerId(hmail),
    event_type: 'hard_bounce',
    event_key: crypto.randomUUID(),
    payload: {
      reason: error ? String(error.message || error) : 'unknown',
      code: error ? error.code : null,
    },
    occurred_at: new Date().toISOString(),
  }).catch((err) => this.logerror(`failed to enqueue bounce: ${err.message}`));

  next();
};
