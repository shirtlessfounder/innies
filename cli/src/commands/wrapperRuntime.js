import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fail } from '../utils.js';

function binaryCandidates(binaryName) {
  const whichAll = spawnSync('sh', ['-lc', `which -a ${binaryName}`], { encoding: 'utf8' });
  if (whichAll.status !== 0) {
    return [];
  }

  return whichAll.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function resolveWrappedBinary(input) {
  const {
    binaryName,
    displayName,
    overrideEnvVar,
    wrapperPath = `${homedir()}/.local/bin/${binaryName}`
  } = input;

  const override = process.env[overrideEnvVar]?.trim();
  if (override) {
    return override;
  }

  const candidates = binaryCandidates(binaryName);
  if (candidates.length === 0) {
    fail(`Could not find ${displayName} CLI binary in PATH.`);
  }

  const nonWrapper = candidates.find((candidate) => candidate !== wrapperPath);
  if (nonWrapper) {
    return nonWrapper;
  }

  fail(
    `${displayName} binary resolution failed (only wrapper found). Set ${overrideEnvVar} to the real ${displayName} binary path.`
  );
}

export function classifyRuntimeFailure(output) {
  const text = output.toLowerCase();

  if (text.includes('token mode not enabled') || text.includes('not-enabled') || text.includes('org not allowlisted')) {
    return 'not_enabled';
  }

  if (
    (text.includes('expired') && text.includes('token'))
    || (text.includes('expired') && text.includes('session'))
    || text.includes('login expired')
  ) {
    return 'expired';
  }

  if (
    text.includes('capacity unavailable')
    || text.includes('no eligible credential')
    || text.includes('all token credential attempts exhausted')
    || text.includes('rate limit')
    || text.includes('429')
  ) {
    return 'capacity';
  }

  if (
    text.includes('unauthorized')
    || text.includes('invalid api key')
    || text.includes('invalid token')
    || text.includes('authentication_error')
    || text.includes('401')
    || text.includes('403')
  ) {
    return 'unauthorized';
  }

  return null;
}

export function printRuntimeGuidance(failureClass) {
  const lines = {
    expired: 'Upstream credential appears expired. Refresh the provider login/session token, then retry.',
    unauthorized:
      'Upstream credential was rejected. Verify token validity/scopes and org token-mode setup.',
    not_enabled:
      'Token mode is not enabled for this org. Ask an operator to add the org to TOKEN_MODE_ENABLED_ORGS.',
    capacity:
      'No eligible upstream credential is available right now. Check pool health/capacity and retry.'
  };

  const line = lines[failureClass];
  if (line) {
    console.error(`Innies hint: ${line}`);
  }
}

export function shouldCaptureCommandOutput(envVar) {
  return process.env[envVar] === '1';
}
