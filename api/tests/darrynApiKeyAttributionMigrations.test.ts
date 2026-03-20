import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const initMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init.sql');
const hardCutoverMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix.sql');
const foundationMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts.sql');
const cutoverAccessMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access.sql');
const routingMigrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering.sql');
const migrationPath = resolve(process.cwd(), '../docs/migrations/020_darryn_api_key_attribution.sql');

const initNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init_no_extensions.sql');
const hardCutoverNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix_no_extensions.sql');
const foundationNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts_no_extensions.sql');
const cutoverAccessNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access_no_extensions.sql');
const routingNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering_no_extensions.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/020_darryn_api_key_attribution_no_extensions.sql');

describe('darryn api-key attribution migrations', () => {
  it('adds additive api-key attribution columns for earnings and withdrawal review actions in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ALTER TABLE in_earnings_ledger');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS actor_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL');
    expect(sql).toContain('ALTER TABLE in_withdrawal_requests');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reviewed_by_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL');
  });

  it('keeps the no-extensions migration aligned with the primary api-key attribution changes', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS actor_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reviewed_by_api_key_id uuid REFERENCES in_api_keys(id) ON DELETE SET NULL');
  });

  it('references only tables that already exist in schema history or are altered in the migration', () => {
    const priorSql = [
      readFileSync(initMigrationPath, 'utf8'),
      readFileSync(hardCutoverMigrationPath, 'utf8'),
      readFileSync(foundationMigrationPath, 'utf8'),
      readFileSync(cutoverAccessMigrationPath, 'utf8'),
      readFileSync(routingMigrationPath, 'utf8')
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
      readFileSync(routingNoExtensionsMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(findUnresolvedTableDependencies(priorSql, sql)).toEqual([]);
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
