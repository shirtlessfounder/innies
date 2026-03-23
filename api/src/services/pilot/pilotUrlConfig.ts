const DEFAULT_PILOT_UI_BASE_URL = 'https://www.innies.computer';
const DEFAULT_LOCAL_PILOT_API_BASE_URL = 'http://localhost:4010';
const PILOT_GITHUB_CALLBACK_PATH = '/v1/pilot/auth/github/callback';

function readAbsoluteUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  try {
    return new URL(normalized).toString();
  } catch {
    return null;
  }
}

function readBaseUrl(value: string | null | undefined): string | null {
  const absoluteUrl = readAbsoluteUrl(value);
  if (!absoluteUrl) return null;

  try {
    return new URL(absoluteUrl).origin;
  } catch {
    return null;
  }
}

function isLocalFallbackAllowed(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
}

export function readPilotUiBaseUrl(): string {
  return readBaseUrl(process.env.PILOT_UI_BASE_URL ?? process.env.UI_BASE_URL) ?? DEFAULT_PILOT_UI_BASE_URL;
}

export function readPilotApiBaseUrl(): string | null {
  return readBaseUrl(process.env.PILOT_GITHUB_CALLBACK_URL) ?? readBaseUrl(process.env.INNIES_BASE_URL);
}

export function readPilotGithubCallbackUrl(): string {
  const configuredCallbackUrl = readAbsoluteUrl(process.env.PILOT_GITHUB_CALLBACK_URL);
  if (configuredCallbackUrl) {
    return configuredCallbackUrl;
  }

  const apiBaseUrl = readPilotApiBaseUrl();
  if (apiBaseUrl) {
    return new URL(PILOT_GITHUB_CALLBACK_PATH, `${apiBaseUrl}/`).toString();
  }

  if (isLocalFallbackAllowed()) {
    return new URL(PILOT_GITHUB_CALLBACK_PATH, `${DEFAULT_LOCAL_PILOT_API_BASE_URL}/`).toString();
  }

  throw new Error('Missing pilot GitHub callback configuration. Set PILOT_GITHUB_CALLBACK_URL or INNIES_BASE_URL.');
}
