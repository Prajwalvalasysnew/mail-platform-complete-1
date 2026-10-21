import { z } from 'zod';

/** Trusted deployment settings; customer requests cannot choose a host or model. */
export function aiConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.AI_ENABLED === 'true';
  const number = (name: string, fallback: number, max: number) => z.coerce.number().int().min(1).max(max).parse(env[name] || fallback);
  const model = env.AI_MODEL || 'gpt-oss:120b';
  const baseUrl = env.AI_BASE_URL || '';
  // Agent turns carry the email HTML and tool results, so the defaults leave room for a designed template.
  const contextTokens=number('AI_CONTEXT_TOKENS',32768,131072),maxOutputTokens=number('AI_MAX_OUTPUT_TOKENS',8192,32768);
  const provider=z.enum(['ollama','openai']).parse(env.AI_PROVIDER || 'ollama');
  const think=z.enum(['low','medium','high','true','false']).parse(env.AI_THINK || 'medium');
  if(enabled && contextTokens<maxOutputTokens+2000)throw new Error('AI context must reserve space for instructions, input and output');
  if (enabled) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid AI_BASE_URL');
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:' && env.AI_ALLOW_PRIVATE_HTTP !== 'true') throw new Error('AI_BASE_URL requires TLS');
    if (/cloud/i.test(model) && env.AI_ALLOW_CLOUD !== 'true') throw new Error('Cloud inference requires AI_ALLOW_CLOUD=true');
  }
  return {
    enabled, model, provider, think:think==='true'?true:think==='false'?false:think, baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
    token: env.AI_GATEWAY_TOKEN || '',
    tenants: (env.AI_ENABLED_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean),
    timeoutMs: number('AI_TIMEOUT_MS', 90000, 180000),
    // Whole multi-step agent turn (several model calls plus tool execution).
    agentTimeoutMs: number('AI_AGENT_TIMEOUT_MS', 240000, 900000),
    agentMaxSteps: number('AI_AGENT_MAX_STEPS', 10, 24),
    maxOutputTokens, contextTokens,
    concurrency: number('AI_CONCURRENCY', 1, 8),
    dailyLimit: number('AI_USER_DAILY_LIMIT', 50, 1000),
    retentionHours: number('AI_RETENTION_HOURS', 24, 168),
    // Saved conversations; each new message extends the window, like other chat products.
    chatRetentionDays: number('AI_CHAT_RETENTION_DAYS', 30, 365),
  };
}

export function aiEnabledFor(customerId: string): boolean {
  const c = aiConfig();
  return c.enabled && (c.tenants.includes('*') || c.tenants.includes(customerId));
}

/** Application admission estimate, not the cloud provider's actual context window. */
export function aiInputByteLimit(operation:string,c=aiConfig()){
 const reserve=operation==='subjects'?Math.min(700,c.maxOutputTokens):operation==='compact'?Math.min(1200,c.maxOutputTokens):c.maxOutputTokens;
 return Math.max(512,(c.contextTokens-reserve-1500)*2);
}
