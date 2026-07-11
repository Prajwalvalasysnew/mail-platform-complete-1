/** Central Pino redaction contract shared by every runtime service. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.body',
  'res.headers["set-cookie"]',
  'authorization', 'cookie', 'password', 'token', 'api_key', 'apiKey',
  'secret', 'previous_secret', 'webhook_secret', 'key_hash', 'private_key',
  'email', 'recipient', 'to', 'from', 'to_address', 'from_address', 'reply_to',
  'html', 'text', 'html_body', 'text_body', 'body', 'payload', 'metadata',
  'response', 'smtp_response', 'url',
  'reason',
  '*.authorization', '*.cookie', '*.password', '*.token', '*.secret',
  '*.email', '*.recipient', '*.to_address', '*.from_address',
  '*.html', '*.text', '*.body', '*.payload', '*.metadata', '*.response', '*.url',
] as const;

export function privacyLoggerOptions(level = process.env.LOG_LEVEL ?? 'info') {
  return {
    level,
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
    serializers: {
      err: (error: unknown) => {
        if (!(error instanceof Error)) return { type: 'UnknownError', message: '[REDACTED_ERROR]', stack: '' };
        return {
          type: error.name,
          message: sanitizeTelemetryText(error.message),
          stack: error.stack ? sanitizeTelemetryText(error.stack) : '',
          code: (error as Error & { code?: unknown }).code,
        };
      },
    },
  };
}

/** Remove common secrets/PII before exception text is exported to tracing. */
export function sanitizeTelemetryText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:mp_(?:live|test|pub)_[A-Za-z0-9_-]+)\b/g, '[API_KEY]')
    .replace(/([?&](?:token|key|secret|signature|code)=)[^&\s]+/gi, '$1[REDACTED]');
}
