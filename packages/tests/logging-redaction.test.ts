import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { privacyLoggerOptions, sanitizeTelemetryText } from '@platform/shared';

describe('privacy-safe telemetry', () => {
  it('redacts credentials, recipient data, bodies, payloads, and webhook URLs', async () => {
    let output = '';
    const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const logger = pino(privacyLoggerOptions('info'), sink);
    logger.info({
      req: { headers: { authorization: 'Bearer super-secret', cookie: 'sid=secret' }, body: { password: 'hunter2' } },
      email: 'victim@example.com', recipient: 'victim@example.com',
      payload: { message: 'private webhook payload' }, html_body: '<p>private</p>',
      secret: 'webhook-secret', url: 'https://example.com/hook?token=secret',
      err: new Error('SMTP rejected victim@example.com Bearer error.secret'),
      message_id: 'opaque-message-id', customer_id: 'opaque-customer-id',
    }, 'sensitive event');
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('sid=secret');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('victim@example.com');
    expect(output).not.toContain('private webhook payload');
    expect(output).not.toContain('<p>private</p>');
    expect(output).not.toContain('https://example.com');
    expect(output).not.toContain('error.secret');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('opaque-message-id');
    expect(output).toContain('opaque-customer-id');
  });

  it('sanitizes exception text before trace export', () => {
    const sanitized = sanitizeTelemetryText(
      'delivery for victim@example.com failed Bearer abc.def token?token=secret mp_live_abcdef123456'
    );
    expect(sanitized).not.toContain('victim@example.com');
    expect(sanitized).not.toContain('abc.def');
    expect(sanitized).not.toContain('token=secret');
    expect(sanitized).not.toContain('mp_live_abcdef123456');
  });
});
