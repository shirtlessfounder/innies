import { spawn } from 'node:child_process';
import { loadConfig, resolveProviderDefaultModel } from '../config.js';
import { buildCorrelationId, fail } from '../utils.js';
import {
  classifyRuntimeFailure,
  printRuntimeGuidance,
  resolveWrappedBinary,
  shouldCaptureCommandOutput
} from './wrapperRuntime.js';
import { startClaudeProxy } from './claudeProxy.js';

function proxyBase(configBaseUrl) {
  return `${configBaseUrl}/v1/proxy`;
}

function hasExplicitModelArg(args) {
  return args.some((arg) => (
    arg === '--model'
    || arg.startsWith('--model=')
  ));
}

export function resolveClaudeSessionModel(args, fallbackModel) {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg === '--model') {
      const value = args[i + 1];
      if (typeof value === 'string' && !value.startsWith('--')) {
        const normalized = value.trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
      continue;
    }

    if (arg.startsWith('--model=')) {
      const normalized = arg.slice('--model='.length).trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return fallbackModel;
}

function buildClaudeArgs(args, model) {
  if (hasExplicitModelArg(args)) {
    return args;
  }
  return ['--model', model, ...args];
}

export async function runClaude(args) {
  const config = await loadConfig(true);
  if (!config) {
    fail('Not logged in. Run: innies login --token <in_token>');
  }

  const defaultModel = resolveProviderDefaultModel(config, 'anthropic');
  const model = resolveClaudeSessionModel(args, defaultModel);
  const proxyUrl = proxyBase(config.apiBaseUrl);
  const correlationId = buildCorrelationId();
  const claudeBridge = await startClaudeProxy({
    upstreamBaseUrl: config.apiBaseUrl,
    buyerToken: config.token,
    correlationId,
    sessionModel: model
  });
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
    MallocStackLogging: '',
    INNIES_CLAUDE_WRAPPED: '1',
    INNIES_TOKEN: config.token,
    INNIES_API_BASE_URL: config.apiBaseUrl,
    INNIES_PROXY_URL: proxyUrl,
    INNIES_MODEL: model,
    INNIES_ROUTE_MODE: 'token',
    INNIES_CORRELATION_ID: correlationId,
    ANTHROPIC_API_KEY: config.token,
    ANTHROPIC_BASE_URL: claudeBridge.baseUrl,
    OPENAI_API_KEY: config.token,
    OPENAI_BASE_URL: proxyUrl
  };

  const captureOutput = shouldCaptureCommandOutput('INNIES_CAPTURE_CLAUDE_OUTPUT');
  let combinedOutput = '';
  const stdio = captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit';
  const child = spawn(claudeBinary, buildClaudeArgs(args, model), {
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

  async function closeBridge() {
    try {
      await claudeBridge.close();
    } catch {}
  }

  child.on('error', async (error) => {
    await closeBridge();
    fail(`Failed to run claude: ${error.message}`);
  });

  child.on('close', async (code, signal) => {
    await closeBridge();
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

  process.on('SIGINT', () => { void closeBridge(); process.exit(130); });
  process.on('SIGTERM', () => { void closeBridge(); process.exit(143); });
}
