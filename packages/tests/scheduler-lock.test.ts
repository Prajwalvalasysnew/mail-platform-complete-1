import { describe, expect, it } from 'vitest';
import { withSchedulerLock } from '@platform/shared';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('withSchedulerLock', () => {
  it('lets only one concurrent owner run a named scheduler task', async () => {
    const entered = deferred();
    const release = deferred();
    let runs = 0;
    const name = `test-lock-${Date.now()}-${Math.random()}`;

    const first = withSchedulerLock(name, async () => {
      runs += 1;
      entered.resolve();
      await release.promise;
      return 'first';
    });

    await entered.promise;

    const second = await withSchedulerLock(name, async () => {
      runs += 1;
      return 'second';
    });

    release.resolve();
    const firstResult = await first;

    expect(second.ran).toBe(false);
    expect(firstResult).toEqual({ ran: true, result: 'first' });
    expect(runs).toBe(1);
  });
});
