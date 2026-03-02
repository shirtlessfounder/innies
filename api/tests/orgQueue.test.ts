import { describe, expect, it } from 'vitest';
import { OrgQueueManager } from '../src/services/orgQueue.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('OrgQueueManager', () => {
  it('enforces max pending queue size', async () => {
    const queue = new OrgQueueManager(1, 1, 1_000);

    const p1 = queue.run('org-x', async () => {
      await sleep(200);
      return 'first';
    });

    const p2 = queue.run('org-x', async () => 'second');

    await expect(
      queue.run('org-x', async () => 'third')
    ).rejects.toMatchObject({ code: 'capacity_unavailable' });

    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
  });
});
