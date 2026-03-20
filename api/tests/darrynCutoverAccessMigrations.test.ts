import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const initMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init.sql');
const hardCutoverMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix.sql');
const foundationMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts.sql');
const migrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access.sql');

const initNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init_no_extensions.sql');
const hardCutoverNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix_no_extensions.sql');
const foundationNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts_no_extensions.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/018_darryn_cutover_access_no_extensions.sql');

describe('darryn cutover access migrations', () => {
  it('creates GitHub identity and cutover freeze tables in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_github_identities');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_pilot_cutover_freezes');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_pilot_cutover_freeze_credentials');
    expect(sql).toContain("CHECK (operation_kind IN ('cutover', 'rollback'))");
    expect(sql).toContain('UNIQUE (github_user_id)');
    expect(sql).toContain('UNIQUE (github_login)');
  });

  it('keeps the no-extensions migration aligned with the primary cutover-access tables', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_github_identities');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_pilot_cutover_freezes');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_pilot_cutover_freeze_credentials');
  });

  it('references only tables that already exist in schema history or are created in the migration', () => {
    const priorSql = [
      readFileSync(initMigrationPath, 'utf8'),
      readFileSync(hardCutoverMigrationPath, 'utf8'),
      readFileSync(foundationMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(migrationPath, 'utf8');

    expect(findUnresolvedTableDependencies(priorSql, sql)).toEqual([]);
  });

  it('keeps the no-extensions migration on the same table dependency graph', () => {
    const priorSql = [
      readFileSync(initNoExtensionsMigrationPath, 'utf8'),
      readFileSync(hardCutoverNoExtensionsMigrationPath, 'utf8'),
      readFileSync(foundationNoExtensionsMigrationPath, 'utf8')
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
