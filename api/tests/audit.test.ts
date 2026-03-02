import { describe, expect, it, vi } from 'vitest';
import { logSensitiveAction } from '../src/utils/audit.js';

describe('audit helper', () => {
  it('fills actor/org defaults from auth context', async () => {
    const createEvent = vi.fn(async () => ({ id: 'audit_1' }));
    const repo = { createEvent };

    await logSensitiveAction(repo, { apiKeyId: 'key_1', orgId: 'org_1' }, {
      action: 'seller_key.update',
      targetType: 'seller_key',
      targetId: 'seller_1'
    });

    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith({
      actorApiKeyId: 'key_1',
      orgId: 'org_1',
      action: 'seller_key.update',
      targetType: 'seller_key',
      targetId: 'seller_1',
      metadata: undefined
    });
  });
});
