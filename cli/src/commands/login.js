import { defaultModelId, saveConfig } from '../config.js';
import { fail, parseFlag } from '../utils.js';

export async function runLogin(args) {
  const token = parseFlag(args, '--token');
  const baseUrl = parseFlag(args, '--base-url') ?? 'https://gateway.headroom.ai';
  const model = parseFlag(args, '--model') ?? defaultModelId();

  if (!token) {
    fail('Missing --token. Example: innies login --token hr_live_xxx');
  }

  if (!token.startsWith('hr_')) {
    fail('Token must start with hr_.');
  }

  const config = await saveConfig(token, baseUrl, model);

  console.log('Innies login successful.');
  console.log(`Config saved: ${config.apiBaseUrl}`);
  console.log(`Default model: ${config.defaultModel}`);
}
