// Strip our internal routing headers before mail leaves the platform.
// These should never appear in received mail.

exports.register = function () {
  this.register_hook('queue_outbound', 'strip_internal_headers');
};

exports.strip_internal_headers = function (next, connection) {
  const txn = connection.transaction;
  if (!txn) return next();

  // Capture customer/message ID into transaction notes so other plugins can use them
  txn.notes.customer_id = (txn.header.get('X-MP-Customer-ID') || '').trim();
  txn.notes.message_id = (txn.header.get('X-MP-Message-ID') || '').trim();
  txn.notes.ip_pool = (txn.header.get('X-MP-IP-Pool') || '').trim();

  txn.remove_header('X-MP-Customer-ID');
  txn.remove_header('X-MP-Message-ID');
  txn.remove_header('X-MP-IP-Pool');

  next();
};
