import {defineConfig} from 'vitest/config';
// These suites do not query a database or queue. Keep the integration setup
// (and its schema migrations) out of this deliberately bounded test command.
export default defineConfig({test:{environment:'node',include:['customer-campaigns.test.ts','campaign-subject-test.test.ts','customer-release.test.ts'],fileParallelism:false}});
