import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';
import { fileExists } from '../utils.js';

function findCommand(bin) {
  const which = spawnSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  if (which.status !== 0) {
    return null;
  }

  const value = which.stdout.trim();
  return value.length > 0 ? value : null;
}

export async function runDoctor() {
  const config = await loadConfig(false);

  const checks = [];
  const warnings = [];

  checks.push({
    name: 'config',
    ok: config !== null,
    note: config ? `loaded ${config.apiBaseUrl}` : 'missing ~/.innies/config.json (run innies login)'
  });

  checks.push({
    name: 'token',
    ok: !!config?.token,
    note: config?.token ? 'present' : 'missing'
  });

  const claudePath = findCommand('claude');
  checks.push({
    name: 'claude_binary',
    ok: claudePath !== null,
    note: claudePath ?? 'not found in PATH'
  });

  const linkedWrapperPath = `${process.env.HOME ?? ''}/.local/bin/claude`;
  const wrapperPresent = await fileExists(linkedWrapperPath);
  if (!wrapperPresent) {
    warnings.push({
      name: 'claude_link_wrapper',
      note: `${linkedWrapperPath} (optional; run innies link claude)`
    });
  } else {
    checks.push({
      name: 'claude_link_wrapper',
      ok: true,
      note: linkedWrapperPath
    });
  }

  let failed = 0;
  for (const check of checks) {
    const status = check.ok ? 'OK' : 'FAIL';
    if (!check.ok) {
      failed += 1;
    }
    console.log(`${status}  ${check.name}  ${check.note}`);
  }
  for (const warning of warnings) {
    console.log(`WARN  ${warning.name}  ${warning.note}`);
  }

  if (config) {
    console.log(`Innies endpoint: ${config.apiBaseUrl}/v1/proxy`);
    console.log(`Default model: ${config.defaultModel}`);
  }

  if (failed > 0) {
    process.exit(1);
  }

  console.log('Innies doctor passed.');
}
