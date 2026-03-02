import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { buildCorrelationId, fail } from '../utils.js';

function proxyBase(configBaseUrl) {
  return `${configBaseUrl}/v1/proxy`;
}

function resolveClaudeBinary() {
  const wrapperPath = `${homedir()}/.local/bin/claude`;

  if (process.env.HEADROOM_CLAUDE_BIN && process.env.HEADROOM_CLAUDE_BIN.trim()) {
    return process.env.HEADROOM_CLAUDE_BIN.trim();
  }

  const whichAll = spawnSync('sh', ['-lc', 'which -a claude'], { encoding: 'utf8' });
  if (whichAll.status !== 0) {
    fail('Could not find Claude CLI binary in PATH.');
  }

  const candidates = whichAll.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const nonWrapper = candidates.find((candidate) => candidate !== wrapperPath);
  if (nonWrapper) {
    return nonWrapper;
  }

  fail(
    'Claude binary resolution failed (only wrapper found). Set HEADROOM_CLAUDE_BIN to the real Claude binary path.'
  );
}

function classifyTokenAuthFailure(output) {
  const text = output.toLowerCase();

  if (text.includes('token mode not enabled') || text.includes('not-enabled') || text.includes('org not allowlisted')) {
    return 'not_enabled';
  }

  if (text.includes('expired') && text.includes('token')) {
    return 'expired';
  }

  if (text.includes('unauthorized') || text.includes('invalid api key') || text.includes('invalid token') || text.includes('401') || text.includes('403')) {
    return 'unauthorized';
  }

  return null;
}

function printTokenAuthGuidance(failureClass) {
  const lines = {
    expired: 'Token auth failed: token appears expired. Re-auth and rotate token credentials, then retry.',
    unauthorized:
      'Token auth failed: credential rejected by upstream. Verify token validity/scopes and org token-mode setup.',
    not_enabled:
      'Token auth failed: token mode is not enabled for this org. Ask an operator to add the org to TOKEN_MODE_ENABLED_ORGS.'
  };

  const line = lines[failureClass];
  if (line) {
    console.error(`Innies hint: ${line}`);
  }
}

function shouldCaptureClaudeOutput() {
  return process.env.HEADROOM_CAPTURE_CLAUDE_OUTPUT === '1';
}

export async function runClaude(args) {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <hr_token>');
  }

  if (process.env.HEADROOM_CLAUDE_WRAPPED === '1') {
    fail('Detected wrapper recursion. Set HEADROOM_CLAUDE_BIN to the real Claude binary path.');
  }

  const proxyUrl = proxyBase(config.apiBaseUrl);
  const correlationId = buildCorrelationId();
  const claudeBinary = resolveClaudeBinary();

  console.log(
    `Innies connected | model ${config.defaultModel} | proxy ${proxyUrl} | request ${correlationId}`
  );

  const env = {
    ...process.env,
    HEADROOM_CLAUDE_WRAPPED: '1',
    HEADROOM_TOKEN: config.token,
    HEADROOM_API_BASE_URL: config.apiBaseUrl,
    HEADROOM_PROXY_URL: proxyUrl,
    HEADROOM_MODEL: config.defaultModel,
    HEADROOM_ROUTE_MODE: 'token',
    HEADROOM_CORRELATION_ID: correlationId,
    ANTHROPIC_API_KEY: config.token,
    ANTHROPIC_BASE_URL: proxyUrl,
    OPENAI_API_KEY: config.token,
    OPENAI_BASE_URL: proxyUrl
  };

  const captureOutput = shouldCaptureClaudeOutput();
  let combinedOutput = '';
  const stdio = captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit';
  const child = spawn(claudeBinary, args, {
    stdio,
    env
  });

  if (captureOutput) {
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      combinedOutput += text;
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      combinedOutput += text;
    });
  }

  child.on('error', (error) => {
    fail(`Failed to run claude: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    if ((code ?? 0) !== 0 && captureOutput) {
      const failureClass = classifyTokenAuthFailure(combinedOutput);
      if (failureClass) printTokenAuthGuidance(failureClass);
    }

    process.exit(code ?? 0);
  });
}
