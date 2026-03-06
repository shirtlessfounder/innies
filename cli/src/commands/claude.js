import { spawn } from 'node:child_process';
import { loadConfig, resolveProviderDefaultModel } from '../config.js';
import { buildCorrelationId, fail } from '../utils.js';
import {
  classifyRuntimeFailure,
  printRuntimeGuidance,
  resolveWrappedBinary,
  shouldCaptureCommandOutput
} from './wrapperRuntime.js';

function proxyBase(configBaseUrl) {
  return `${configBaseUrl}/v1/proxy`;
}

export async function runClaude(args) {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <in_token>');
  }

  const model = resolveProviderDefaultModel(config, 'anthropic');
  const proxyUrl = proxyBase(config.apiBaseUrl);
  const correlationId = buildCorrelationId();
  const claudeBinary = resolveWrappedBinary({
    binaryName: 'claude',
    displayName: 'Claude',
    overrideEnvVar: 'INNIES_CLAUDE_BIN'
  });

  console.log(
    `Innies connected | model ${model} | proxy ${proxyUrl} | request ${correlationId}`
  );

  const env = {
    ...process.env,
    INNIES_CLAUDE_WRAPPED: '1',
    INNIES_TOKEN: config.token,
    INNIES_API_BASE_URL: config.apiBaseUrl,
    INNIES_PROXY_URL: proxyUrl,
    INNIES_MODEL: model,
    INNIES_ROUTE_MODE: 'token',
    INNIES_CORRELATION_ID: correlationId,
    ANTHROPIC_API_KEY: config.token,
    ANTHROPIC_BASE_URL: config.apiBaseUrl,
    OPENAI_API_KEY: config.token,
    OPENAI_BASE_URL: proxyUrl
  };

  const captureOutput = shouldCaptureCommandOutput('INNIES_CAPTURE_CLAUDE_OUTPUT');
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
      const failureClass = classifyRuntimeFailure(combinedOutput);
      if (failureClass) printRuntimeGuidance(failureClass);
    }

    process.exit(code ?? 0);
  });
}
