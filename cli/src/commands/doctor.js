import { spawnSync } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { fileExists } from '../utils.js';

function findCommand(bin) {
  // Try login shell first, then fall back to current shell's PATH.
  // nvm/fnm/volta add to .bashrc/.zshrc but not sh's .profile,
  // so sh -lc misses binaries installed via node version managers.
  const attempts = [
    ['sh', ['-lc', `command -v ${bin}`]],
    ['bash', ['-lc', `command -v ${bin}`]],
  ];
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    const value = result.status === 0 ? result.stdout.trim() : '';
    if (value.length > 0) return value;
  }
  return null;
}

async function resolveBinary(bin, overrideEnvVar) {
  const override = process.env[overrideEnvVar]?.trim();
  if (override) {
    try {
      await access(override, constants.X_OK);
      return {
        ok: true,
        note: `${override} (via ${overrideEnvVar})`
      };
    } catch {
      return {
        ok: false,
        note: `${override} (via ${overrideEnvVar}; not executable or not found)`
      };
    }
  }

  const path = findCommand(bin);
  return {
    ok: path !== null,
    note: path ?? 'not found in PATH'
  };
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

  const claudeBinary = await resolveBinary('claude', 'INNIES_CLAUDE_BIN');
  checks.push({
    name: 'claude_binary',
    ok: claudeBinary.ok,
    note: claudeBinary.note
  });

  const codexBinary = await resolveBinary('codex', 'INNIES_CODEX_BIN');
  checks.push({
    name: 'codex_binary',
    ok: codexBinary.ok,
    note: codexBinary.note
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
    console.log(`Innies endpoint (claude): ${config.apiBaseUrl}/v1/proxy`);
    console.log(`Innies endpoint (codex): ${config.apiBaseUrl}/v1/proxy/v1`);
    console.log(`Fallback model: ${config.defaultModel}`);
    console.log(`Provider defaults: anthropic=${config.providerDefaults.anthropic} openai=${config.providerDefaults.openai}`);
  }

  if (failed > 0) {
    process.exit(1);
  }

  console.log('Innies doctor passed.');
}
