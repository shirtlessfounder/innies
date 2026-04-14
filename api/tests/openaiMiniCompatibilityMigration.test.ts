import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), '../docs/migrations/029_openai_model_gpt_5_4_mini.sql');
const noExtensionsMigrationPath = resolve(
  process.cwd(),
  '../docs/migrations/029_openai_model_gpt_5_4_mini_no_extensions.sql'
);

describe('openai gpt-5.4-mini compatibility migrations', () => {
  it('seeds an active compatibility rule in the primary migration', () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expectCompatibilityContract(sql);
  });

  it('keeps the no-extensions migration aligned with the primary compatibility contract', () => {
    const sql = readFileSync(noExtensionsMigrationPath, 'utf8');

    expectCompatibilityContract(sql);
  });
});

function expectCompatibilityContract(sql: string): void {
  expect(sql).toContain('insert into in_model_compatibility_rules');
  expect(sql).toContain("'openai'");
  expect(sql).toContain("'gpt-5.4-mini'");
  expect(sql).toContain('supports_streaming');
  expect(sql).toContain('supports_tools');
  expect(sql).toContain('true,');
  expect(sql).toContain("where provider = 'openai'");
  expect(sql).toContain("and model = 'gpt-5.4-mini'");
  expect(sql).toContain('-- No niyant grant changes: seeds compatibility data only.');
}
