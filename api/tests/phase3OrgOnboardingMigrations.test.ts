import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../src/repos/tableNames.js';

const initMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init.sql');
const hardCutoverMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix.sql');
const foundationMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts.sql');
const cutoverAccessMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access.sql');
const routingMeteringMigrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering.sql');
const apiKeyAttributionMigrationPath = resolve(process.cwd(), '../docs/migrations/020_darryn_api_key_attribution.sql');
const paymentsRechargeMigrationPath = resolve(process.cwd(), '../docs/migrations/021_darryn_payments_recharge.sql');
const migrationPath = resolve(process.cwd(), '../docs/migrations/022_phase3_org_onboarding.sql');

const initNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init_no_extensions.sql');
const hardCutoverNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix_no_extensions.sql');
const foundationNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts_no_extensions.sql');
const cutoverAccessNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access_no_extensions.sql');
const routingMeteringNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering_no_extensions.sql');
const apiKeyAttributionNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/020_darryn_api_key_attribution_no_extensions.sql');
const paymentsRechargeNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/021_darryn_payments_recharge_no_extensions.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/022_phase3_org_onboarding_no_extensions.sql');

describe('phase 3 org onboarding migrations', () => {
  it('pins the primary migration to the additive org onboarding schema', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ALTER TABLE in_users');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS github_login text');
    expect(sql).toContain('ALTER TABLE in_orgs');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL');
    expect(sql).toContain('ALTER TABLE in_memberships');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ended_at timestamptz');
    expect(sql).toContain('ALTER TABLE in_api_keys');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS membership_id uuid REFERENCES in_memberships(id) ON DELETE SET NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revoked_at timestamptz');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_org_invites');
    expect(sql).toContain("CHECK (status IN ('pending', 'revoked', 'accepted'))");
    expect(sql).toContain('created_by_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT');
    expect(sql).toContain('accepted_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL');
    expect(sql).toContain('revoked_by_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL');
    expect(sql).toContain('github_login text NOT NULL');
    expect(sql).toContain('DO $$');
    expect(sql).toContain('UNIQUE (org_id, user_id)');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_org_invites_pending_org_login');
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_api_keys_active_membership');
    expect(sql).toContain('WHERE membership_id IS NOT NULL');
    expect(sql).toContain('AND revoked_at IS NULL');
    expectNiyantPhase3Grants(sql);
  });

  it('keeps the no-extensions migration aligned with the primary org onboarding contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS github_login text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES in_users(id) ON DELETE SET NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ended_at timestamptz');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS membership_id uuid REFERENCES in_memberships(id) ON DELETE SET NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revoked_at timestamptz');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_org_invites');
    expect(sql).toContain("CHECK (status IN ('pending', 'revoked', 'accepted'))");
    expect(sql).toContain('created_by_user_id uuid NOT NULL REFERENCES in_users(id) ON DELETE RESTRICT');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_org_invites_pending_org_login');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_api_keys_active_membership');
    expectNiyantPhase3Grants(sql);
  });

  it('references only tables that already exist in schema history or are created in the migration', () => {
    const priorSql = [
      readFileSync(initMigrationPath, 'utf8'),
      readFileSync(hardCutoverMigrationPath, 'utf8'),
      readFileSync(foundationMigrationPath, 'utf8'),
      readFileSync(cutoverAccessMigrationPath, 'utf8'),
      readFileSync(routingMeteringMigrationPath, 'utf8'),
      readFileSync(apiKeyAttributionMigrationPath, 'utf8'),
      readFileSync(paymentsRechargeMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(migrationPath, 'utf8');

    expect(findUnresolvedTableDependencies(priorSql, sql)).toEqual([]);
  });

  it('keeps the no-extensions migration on the same dependency graph', () => {
    const priorSql = [
      readFileSync(initNoExtensionsMigrationPath, 'utf8'),
      readFileSync(hardCutoverNoExtensionsMigrationPath, 'utf8'),
      readFileSync(foundationNoExtensionsMigrationPath, 'utf8'),
      readFileSync(cutoverAccessNoExtensionsMigrationPath, 'utf8'),
      readFileSync(routingMeteringNoExtensionsMigrationPath, 'utf8'),
      readFileSync(apiKeyAttributionNoExtensionsMigrationPath, 'utf8'),
      readFileSync(paymentsRechargeNoExtensionsMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(findUnresolvedTableDependencies(priorSql, sql)).toEqual([]);
  });

  it('registers the org invites table name', () => {
    expect(TABLES.orgInvites).toBe('in_org_invites');
  });
});

function findUnresolvedTableDependencies(priorSql: string, currentSql: string): string[] {
  const availableTables = new Set<string>([
    ...extractCreatedTables(priorSql),
    ...extractRenamedTables(priorSql),
    ...extractCreatedTables(currentSql)
  ]);

  const requiredTables = new Set<string>([
    ...extractReferencedTables(currentSql),
    ...extractAlteredTables(currentSql)
  ]);

  return Array.from(requiredTables)
    .filter((table) => !availableTables.has(table))
    .sort();
}

function extractCreatedTables(sql: string): string[] {
  return extractMatches(sql, /CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/gi);
}

function extractRenamedTables(sql: string): string[] {
  return extractMatches(sql, /ALTER TABLE IF EXISTS [a-z0-9_]+ RENAME TO ([a-z0-9_]+)/gi);
}

function extractReferencedTables(sql: string): string[] {
  return extractMatches(sql, /REFERENCES ([a-z0-9_]+)\s*\(/gi);
}

function extractAlteredTables(sql: string): string[] {
  return extractMatches(sql, /ALTER TABLE ([a-z0-9_]+)/gi);
}

function extractMatches(sql: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of sql.matchAll(pattern)) {
    matches.push(match[1]);
  }
  return matches;
}

function expectNiyantPhase3Grants(sql: string): void {
  expect(sql).toContain('FROM pg_roles');
  expect(sql).toContain("WHERE rolname = 'niyant'");
  expect(sql).toContain('GRANT ALL PRIVILEGES ON TABLE in_org_invites TO niyant');
  expect(sql).toContain('GRANT SELECT (github_login), INSERT (github_login), UPDATE (github_login), REFERENCES (github_login)');
  expect(sql).toContain('ON TABLE in_users TO niyant');
  expect(sql).toContain('GRANT SELECT (owner_user_id), INSERT (owner_user_id), UPDATE (owner_user_id), REFERENCES (owner_user_id)');
  expect(sql).toContain('ON TABLE in_orgs TO niyant');
  expect(sql).toContain('GRANT SELECT (ended_at), INSERT (ended_at), UPDATE (ended_at), REFERENCES (ended_at)');
  expect(sql).toContain('ON TABLE in_memberships TO niyant');
  expect(sql).toContain('GRANT SELECT (membership_id, revoked_at), INSERT (membership_id, revoked_at), UPDATE (membership_id, revoked_at), REFERENCES (membership_id, revoked_at)');
  expect(sql).toContain('ON TABLE in_api_keys TO niyant');
}
