import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOB_NAMES } from '@platform/worker/scheduler.js';

describe('scheduler inventory release gate', () => {
  it('contains 30 unique, explicitly named periodic controls', () => {
    expect(SCHEDULER_JOB_NAMES).toHaveLength(30);
    expect(SCHEDULER_JOB_NAMES).toContain('workflow_date_triggers');
    expect(new Set(SCHEDULER_JOB_NAMES).size).toBe(SCHEDULER_JOB_NAMES.length);
    for (const name of SCHEDULER_JOB_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });
});
