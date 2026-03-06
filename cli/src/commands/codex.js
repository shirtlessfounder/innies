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
  return `${configBaseUrl}/v1/proxy/v1`;
}

export function hasExplicitModelArg(args) {
  return args.some((arg) => (
    arg === '-m'
    || arg === '--model'
    || arg.startsWith('--model=')
    || (/^-m.+/.test(arg) && arg !== '-m')
  ));
}

export function buildCodexArgs(input) {
  const { args, model } = input;
  const forcedArgs = [
    '--config', 'model_provider="openai"',
    '--config', 'model_providers.openai.env_key="OPENAI_API_KEY"',
    '--config', 'model_providers.openai.wire_api="responses"',
    '--config', 'model_providers.openai.env_http_headers."x-request-id"="INNIES_CORRELATION_ID"',
    '--config', 'model_providers.openai.env_http_headers."x-innies-provider-pin"="INNIES_PROVIDER_PIN"'
  ];

  if (!hasExplicitModelArg(args)) {
    forcedArgs.push('--model', model);
  }

  return [...forcedArgs, ...args];
}

export async function runCodex(args) {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <in_token>');
  }

  const model = resolveProviderDefaultModel(config, 'openai');
  const proxyUrl = proxyBase(config.apiBaseUrl);
  const correlationId = buildCorrelationId();
  const codexBinary = resolveWrappedBinary({
    binaryName: 'codex',
    displayName: 'Codex',
    overrideEnvVar: 'INNIES_CODEX_BIN'
  });

  console.log(
    `Innies connected | model ${model} | proxy ${proxyUrl} | request ${correlationId}`
  );

  const env = {
    ...process.env,
    INNIES_CODEX_WRAPPED: '1',
    INNIES_TOKEN: config.token,
    INNIES_API_BASE_URL: config.apiBaseUrl,
    INNIES_PROXY_URL: proxyUrl,
    INNIES_MODEL: model,
    INNIES_ROUTE_MODE: 'token',
    INNIES_CORRELATION_ID: correlationId,
    INNIES_PROVIDER_PIN: 'true',
    OPENAI_API_KEY: config.token,
    OPENAI_BASE_URL: proxyUrl
  };

  const captureOutput = shouldCaptureCommandOutput('INNIES_CAPTURE_CODEX_OUTPUT');
  let combinedOutput = '';
  const stdio = captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit';
  const child = spawn(codexBinary, buildCodexArgs({ args, model }), {
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
    fail(`Failed to run codex: ${error.message}`);
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
