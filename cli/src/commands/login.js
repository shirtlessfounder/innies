import { saveConfig } from '../config.js';
import { fail, parseFlag } from '../utils.js';

export async function runLogin(args) {
  const token = parseFlag(args, '--token');
  const baseUrl = parseFlag(args, '--base-url') ?? 'https://gateway.innies.ai';
  const model = parseFlag(args, '--model');

  if (!token) {
    fail('Missing --token. Example: innies login --token in_live_xxx');
  }

  if (!token.startsWith('in_')) {
    fail('Token must start with in_.');
  }

  const config = await saveConfig(token, baseUrl, model);

  console.log('Innies login successful.');
  console.log(`Config saved: ${config.apiBaseUrl}`);
  console.log(`Fallback model: ${config.defaultModel}`);
  console.log(`Provider defaults: anthropic=${config.providerDefaults.anthropic} openai=${config.providerDefaults.openai}`);
}
