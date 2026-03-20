import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeModule = typeof import('../src/services/runtime.js');

describe('runtime pilot cutover service', () => {
  let runtimeModule: RuntimeModule;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes reserve-floor migration through the token credential repository adapter', async () => {
    const adapter = (runtimeModule.runtime.services.pilotCutovers as any).reserveFloorMigration;
    const migrate = vi.spyOn(runtimeModule.runtime.repos.tokenCredentials, 'migrateReserveFloors').mockResolvedValue({
      migratedCount: 1
    });

    await adapter.migrateReserveFloors({
      db: {},
      fromOrgId: 'org_innies',
      toOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverId: 'cut_1',
      actorUserId: null
    });

    expect(migrate).toHaveBeenCalledWith({
      db: {},
      fromOrgId: 'org_innies',
      toOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverId: 'cut_1',
      actorUserId: null
    });
  });
});
