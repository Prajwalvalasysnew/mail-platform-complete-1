// Seeds a test customer + API key for local development.
// Run with: tsx scripts/seed.ts

import { db, generateApiKeyV2, closeDb } from '../packages/shared/src/index.js';

async function main() {
  const testEmail = 'demo@example.com';

  // Check if already exists
  let customer = await db
    .selectFrom('customers')
    .selectAll()
    .where('email', '=', testEmail)
    .executeTakeFirst();

  if (!customer) {
    customer = await db
      .insertInto('customers')
      .values({
        email: testEmail,
        name: 'Demo Customer',
        tier: 'paid',
        daily_quota: 10_000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    console.log(`✓ Created customer ${customer.id}`);
  } else {
    console.log(`✓ Customer already exists: ${customer.id}`);
  }

  const apiKey = generateApiKeyV2('secret');
  await db
    .insertInto('api_keys')
    .values({
      customer_id: customer.id,
      name: 'seed-key',
      key_prefix: apiKey.prefix,
      key_hash: apiKey.hash,
      key_type: apiKey.key_type,
      scopes: ['send', 'domains', 'suppressions', 'messages', 'webhooks', 'templates'],
    })
    .execute();

  console.log('');
  console.log('========================================');
  console.log('  SEED COMPLETE');
  console.log('========================================');
  console.log(`  Customer ID:  ${customer.id}`);
  console.log(`  Email:        ${customer.email}`);
  console.log(`  API Key:      ${apiKey.plaintext}`);
  console.log('========================================');
  console.log('');
  console.log('Save this API key — it will not be shown again.');
  console.log('');
  console.log('Try it:');
  console.log(`  curl -X POST http://localhost:3000/v1/domains \\`);
  console.log(`    -H "Authorization: Bearer ${apiKey.plaintext}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"domain": "test.example.com"}'`);
  console.log('');

  await closeDb();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
