import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const initMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init.sql');
const hardCutoverMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix.sql');
const foundationMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts.sql');
const cutoverAccessMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access.sql');
const migrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering.sql');

const initNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init_no_extensions.sql');
const hardCutoverNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix_no_extensions.sql');
const foundationNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts_no_extensions.sql');
const cutoverAccessNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access_no_extensions.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/019_darryn_routing_metering_no_extensions.sql');

describe('darryn routing metering migrations', () => {
  it('creates rate-card line items and bootstrap routing-mode seed rows in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rate_card_line_items');
    expect(sql).toContain('REFERENCES in_rate_card_versions(id) ON DELETE CASCADE');
    expect(sql).toContain('routing_mode in_routing_mode NOT NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_rate_card_line_items_lookup');
    expect(sql).toContain("'phase2-bootstrap'");
    expect(sql).toContain("'self-free'");
    expect(sql).toContain("'paid-team-capacity'");
    expect(sql).toContain("'team-overflow-on-contributor-capacity'");
    expect(sql).toContain("'anthropic'");
    expect(sql).toContain("'openai'");
  });

  it('keeps the no-extensions migration aligned with the primary routing-metering contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rate_card_line_items');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_in_rate_card_line_items_lookup');
    expect(sql).toContain("'phase2-bootstrap'");
    expect(sql).toContain("'self-free'");
    expect(sql).toContain("'paid-team-capacity'");
    expect(sql).toContain("'team-overflow-on-contributor-capacity'");
  });

  it('references only tables and enums that already exist in schema history or are created in the migration', () => {
    const priorSql = [
      readFileSync(initMigrationPath, 'utf8'),
      readFileSync(hardCutoverMigrationPath, 'utf8'),
      readFileSync(foundationMigrationPath, 'utf8'),
      readFileSync(cutoverAccessMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(migrationPath, 'utf8');

    expect(findUnresolvedTableDependencies(priorSql, sql)).toEqual([]);
  });

  it('keeps the no-extensions migration on the same dependency graph', () => {
    const priorSql = [
      readFileSync(initNoExtensionsMigrationPath, 'utf8'),
      readFileSync(hardCutoverNoExtensionsMigrationPath, 'utf8'),
      readFileSync(foundationNoExtensionsMigrationPath, 'utf8'),
      readFileSync(cutoverAccessNoExtensionsMigrationPath, 'utf8')
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
