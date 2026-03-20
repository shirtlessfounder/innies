import { beforeAll, describe, expect, it } from 'vitest';

type RuntimeModule = typeof import('../src/services/runtime.js');

describe('runtime pilot cutover service', () => {
  let runtimeModule: RuntimeModule;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
  });

  it('fails closed when reserve-floor migration is not configured yet', async () => {
    const adapter = (runtimeModule.runtime.services.pilotCutovers as any).reserveFloorMigration;

    await expect(adapter.migrateReserveFloors({
      db: {},
      fromOrgId: 'org_innies',
      toOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverId: 'cut_1',
      actorUserId: null
    })).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
      message: 'Pilot cutover unavailable until reserve-floor migration adapter is configured'
    });
  });
});
