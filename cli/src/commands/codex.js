import { spawn } from 'node:child_process';
import { loadConfig, resolveProviderDefaultModel } from '../config.js';
import { buildCorrelationId, fail } from '../utils.js';
import {
  classifyRuntimeFailure,
  printConnectionStatus,
  printRuntimeGuidance,
  resolveWrappedBinary,
  shouldCaptureCommandOutput
} from './wrapperRuntime.js';

const CODEX_PROXY_PROVIDER = 'innies';

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
  const { args, model, proxyUrl } = input;
  const providerPath = `model_providers.${CODEX_PROXY_PROVIDER}`;
  const forcedArgs = [
    '--config', `model_provider="${CODEX_PROXY_PROVIDER}"`,
    '--config', `${providerPath}.name="${CODEX_PROXY_PROVIDER}"`,
    '--config', `${providerPath}.base_url="${proxyUrl}"`,
    '--config', `${providerPath}.env_key="OPENAI_API_KEY"`,
    '--config', `${providerPath}.wire_api="responses"`,
    '--config', `${providerPath}.requires_openai_auth=false`,
    '--config', `${providerPath}.supports_websockets=false`,
    '--config', 'responses_websockets_v2=false',
    '--config', `${providerPath}.env_http_headers."x-request-id"="INNIES_CORRELATION_ID"`,
    '--config', `${providerPath}.env_http_headers."x-innies-provider-pin"="INNIES_PROVIDER_PIN"`
  ];

  if (!hasExplicitModelArg(args)) {
    forcedArgs.push('--model', model);
  }

  return [...forcedArgs, ...args];
}

export async function runCodex(args) {
  // Extract --token flag before passing args to codex
  let inlineToken = null;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && i + 1 < args.length) {
      inlineToken = args[++i];
    } else if (args[i].startsWith('--token=')) {
      inlineToken = args[i].slice('--token='.length);
    } else {
      filteredArgs.push(args[i]);
    }
  }
  args = filteredArgs;

  let config = await loadConfig(true);
  if (!config && !inlineToken) {
    fail('Not logged in. Run: innies login --token <in_token>');
  }
  if (inlineToken) {
    config = config || { apiBaseUrl: 'https://api.innies.computer', providerDefaults: {} };
    config.token = inlineToken;
  }

  const model = resolveProviderDefaultModel(config, 'openai');
  const proxyUrl = proxyBase(config.apiBaseUrl);
  const correlationId = buildCorrelationId();
  const codexBinary = resolveWrappedBinary({
    binaryName: 'codex',
    displayName: 'Codex',
    overrideEnvVar: 'INNIES_CODEX_BIN'
  });

  printConnectionStatus({ model, proxyUrl, correlationId });

  const {
    OPENAI_BASE_URL: _deprecatedOpenAiBaseUrl,
    MallocStackLogging: _mallocStackLogging,
    MallocStackLoggingDirectory: _mallocStackLoggingDirectory,
    ...inheritedEnv
  } = process.env;

  const env = {
    ...inheritedEnv,
    INNIES_CODEX_WRAPPED: '1',
    INNIES_TOKEN: config.token,
    INNIES_API_BASE_URL: config.apiBaseUrl,
    INNIES_PROXY_URL: proxyUrl,
    INNIES_MODEL: model,
    INNIES_ROUTE_MODE: 'token',
    INNIES_CORRELATION_ID: correlationId,
    INNIES_PROVIDER_PIN: 'true',
    OPENAI_API_KEY: config.token
  };

  const captureOutput = shouldCaptureCommandOutput('INNIES_CAPTURE_CODEX_OUTPUT');
  let combinedOutput = '';
  const stdio = captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit';
  const child = spawn(codexBinary, buildCodexArgs({ args, model, proxyUrl }), {
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
