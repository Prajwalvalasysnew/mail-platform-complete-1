#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, process.argv[2] || '.env.production.example');
const useTemplate = envPath.endsWith('.example');

const required = [
  'NODE_ENV',
  'API_DATABASE_URL',
  'SERVICE_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'HARAKA_OUTBOUND_PASS',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'VERP_SECRET',
  'API_KEY_PEPPER',
  'ADMIN_SESSION_PEPPER',
  'USER_SESSION_PEPPER',
  'MFA_RECOVERY_PEPPER',
  'ADMIN_TOKEN',
  'METRICS_TOKEN',
  'ADMIN_PASSWORD_LOGIN_DISABLED',
  'PLATFORM_DOMAIN',
  'APP_BASE_URL',
  'TRACKING_DOMAIN',
  'BOUNCE_DOMAIN',
  'CORS_ALLOWED_ORIGINS',
  'DELIVERY_TRANSPORT',
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
];

const secretNames = new Set([
  'API_DATABASE_URL',
  'SERVICE_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'HARAKA_OUTBOUND_PASS',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'VERP_SECRET',
  'API_KEY_PEPPER',
  'ADMIN_SESSION_PEPPER',
  'USER_SESSION_PEPPER',
  'MFA_RECOVERY_PEPPER',
  'ADMIN_TOKEN',
  'METRICS_TOKEN',
  'SES_SMTP_PASS',
]);

function parseEnv(path) {
  if (!existsSync(path)) throw new Error(`Missing env file: ${path}`);
  const out = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    out[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function looksPlaceholder(value) {
  const v = String(value || '').trim().toLowerCase();
  return (
    !v ||
    v.includes('replace-with') ||
    v.includes('change-me') ||
    v.includes('changeme') ||
    v.includes('placeholder') ||
    v.includes('example.com') ||
    v.includes('localhost') ||
    /^0+$/.test(v) ||
    (v.length > 1 && /^(.)\1+$/.test(v))
  );
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function composeConfig(envFile) {
  const stdout = execFileSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', 'docker-compose.yml', '-f', 'docker-compose.production.yml', 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(stdout);
}

const env = parseEnv(envPath);
const failures = [];

for (const name of required) {
  check(Boolean(env[name]), `${name} is required`, failures);
}

check(env.NODE_ENV === 'production', 'NODE_ENV must be production', failures);
check(env.ADMIN_PASSWORD_LOGIN_DISABLED === 'true', 'ADMIN_PASSWORD_LOGIN_DISABLED must be true in production', failures);
check(/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY || '') || useTemplate, 'ENCRYPTION_KEY must be a 64-char hex value', failures);

if (!useTemplate) {
  for (const name of secretNames) {
    if (env[name] !== undefined) {
      check(!looksPlaceholder(env[name]), `${name} still looks like a placeholder/default`, failures);
      check(String(env[name]).length >= 16, `${name} must be at least 16 characters`, failures);
    }
  }
  for (const name of ['PLATFORM_DOMAIN', 'APP_BASE_URL', 'TRACKING_DOMAIN', 'BOUNCE_DOMAIN', 'CORS_ALLOWED_ORIGINS']) {
    check(!looksPlaceholder(env[name]), `${name} must be a real production domain/origin`, failures);
  }
  check(!looksPlaceholder(env.OIDC_ISSUER_URL), 'OIDC_ISSUER_URL must be a real identity-provider issuer URL', failures);
  check(!looksPlaceholder(env.OIDC_CLIENT_ID), 'OIDC_CLIENT_ID must be a real client ID', failures);
}

let config;
try {
  config = composeConfig(envPath);
} catch (err) {
  failures.push(`docker compose production config failed: ${err.message}`);
}

if (config?.services) {
  for (const service of ['api', 'worker', 'tracker', 'haraka-outbound', 'haraka-inbound']) {
    check(config.services[service]?.environment?.NODE_ENV === 'production', `${service} must run with NODE_ENV=production`, failures);
  }
  for (const service of ['api', 'worker', 'tracker', 'smtp-gateway']) {
    check(Boolean(config.services[service]?.environment?.METRICS_TOKEN), `${service} must require METRICS_TOKEN`, failures);
  }
  check(config.services.api?.environment?.ADMIN_PASSWORD_LOGIN_DISABLED === 'true', 'api must disable password admin login in production', failures);
  check(Boolean(config.services.api?.environment?.OIDC_ISSUER_URL), 'api must configure OIDC_ISSUER_URL in production', failures);
  check(Boolean(config.services.api?.environment?.OIDC_CLIENT_ID), 'api must configure OIDC_CLIENT_ID in production', failures);
  for (const service of ['postgres', 'redis', 'worker']) {
    const ports = config.services[service]?.ports || [];
    check(ports.length === 0, `${service} must not publish host ports in production overlay`, failures);
  }
}

if (failures.length) {
  console.error('Production readiness check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Production readiness check passed for ${envPath}${useTemplate ? ' (template mode)' : ''}`);
