import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), '../docs/migrations/023_token_credential_access_token_fingerprint.sql');
const noExtensionsMigrationPath = resolve(process.cwd(), '../docs/migrations/023_token_credential_access_token_fingerprint_no_extensions.sql');

describe('token credential access-token fingerprint migrations', () => {
  it('adds the fingerprint column and unique non-revoked constraint in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ALTER TABLE in_token_credentials');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS access_token_sha256 text');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_token_credentials_access_token_sha256_active');
    expect(sql).toContain('ON in_token_credentials (access_token_sha256)');
    expect(sql).toContain("WHERE access_token_sha256 IS NOT NULL");
    expect(sql).toContain("AND status <> 'revoked'");
    expect(sql).toContain("WHERE rolname = 'niyant'");
    expect(sql).toContain('GRANT SELECT (access_token_sha256), INSERT (access_token_sha256), UPDATE (access_token_sha256), REFERENCES (access_token_sha256)');
    expect(sql).toContain('ON TABLE in_token_credentials TO niyant');
  });

  it('keeps the no-extensions migration aligned with the primary fingerprint contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS access_token_sha256 text');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_in_token_credentials_access_token_sha256_active');
    expect(sql).toContain("WHERE access_token_sha256 IS NOT NULL");
    expect(sql).toContain("AND status <> 'revoked'");
    expect(sql).toContain("WHERE rolname = 'niyant'");
    expect(sql).toContain('GRANT SELECT (access_token_sha256), INSERT (access_token_sha256), UPDATE (access_token_sha256), REFERENCES (access_token_sha256)');
    expect(sql).toContain('ON TABLE in_token_credentials TO niyant');
  });
});
