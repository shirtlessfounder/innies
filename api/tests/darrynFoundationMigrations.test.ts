import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const initMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init.sql');
const hardCutoverMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix.sql');
const migrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts.sql');
const initNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/001_checkpoint1_init_no_extensions.sql');
const hardCutoverNoExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/005_hard_cutover_in_prefix_no_extensions.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/017_darryn_foundation_contracts_no_extensions.sql');

describe('darryn foundation contract migrations', () => {
  it('creates the shared contract enums and tables in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain("CREATE TYPE in_finalization_kind AS ENUM ('served_request', 'correction', 'reversal')");
    expect(sql).toContain("CREATE TYPE in_projector_type AS ENUM ('wallet', 'earnings')");
    expect(sql).toContain("CREATE TYPE in_projector_state AS ENUM ('pending_projection', 'projected', 'needs_operator_correction')");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rate_card_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_canonical_metering_events');
    expect(sql).toContain('UNIQUE (request_id, attempt_no, finalization_kind)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_metering_projector_states');
    expect(sql).toContain('PRIMARY KEY (metering_event_id, projector)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_wallet_ledger');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_earnings_ledger');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_withdrawal_requests');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_fnf_api_key_ownership');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_fnf_token_credential_ownership');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_cutover_records');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rollback_records');
  });

  it('keeps the no-extensions migration aligned with the primary contract tables', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rate_card_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_canonical_metering_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_metering_projector_states');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_wallet_ledger');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_earnings_ledger');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_withdrawal_requests');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_fnf_api_key_ownership');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_fnf_token_credential_ownership');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_cutover_records');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS in_rollback_records');
  });

  it('references only tables that already exist in schema history or are created in the migration', () => {
    const priorSql = [
      readFileSync(initMigrationPath, 'utf8'),
      readFileSync(hardCutoverMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(migrationPath, 'utf8');

    const unresolved = findUnresolvedTableDependencies(priorSql, sql);

    expect(unresolved).toEqual([]);
  });

  it('keeps the no-extensions migration on the same table dependency graph', () => {
    const priorSql = [
      readFileSync(initNoExtensionsMigrationPath, 'utf8'),
      readFileSync(hardCutoverNoExtensionsMigrationPath, 'utf8')
    ].join('\n');
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    const unresolved = findUnresolvedTableDependencies(priorSql, sql);

    expect(unresolved).toEqual([]);
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
