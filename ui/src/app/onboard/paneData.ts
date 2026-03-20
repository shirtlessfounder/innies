import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type PaneLineKind =
  | 'blank'
  | 'body'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'list'
  | 'quote'
  | 'codeFence'
  | 'code'
  | 'table';

export type PaneLine = {
  number: number;
  text: string;
  kind: PaneLineKind;
};

export type OnboardingPane = {
  fileName: string;
  title: string;
  contents: string;
  lines: PaneLine[];
};

export const ONBOARDING_FILES = [
  'CLAUDE_CODEX_OAUTH_TOKENS.md',
  'CLI_ONBOARDING.md',
  'OPENCLAW_ONBOARDING.md',
  'CONDUCTOR_ONBOARDING.md',
] as const;

function lineKind(line: string, inCodeBlock: boolean): PaneLineKind {
  if (line.trim().length === 0) return 'blank';
  if (line.startsWith('```')) return 'codeFence';
  if (inCodeBlock) return 'code';
  if (line.startsWith('# ')) return 'heading1';
  if (line.startsWith('## ')) return 'heading2';
  if (line.startsWith('### ')) return 'heading3';
  if (/^(\d+\.|- |\* )/.test(line)) return 'list';
  if (line.startsWith('> ')) return 'quote';
  if (line.startsWith('|')) return 'table';
  return 'body';
}

export function buildPane(fileName: string, contents: string): OnboardingPane {
  const normalized = contents.replace(/\r\n/g, '\n');
  const title = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fileName;
  const lines: PaneLine[] = [];
  let inCodeBlock = false;

  for (const [index, rawLine] of normalized.split('\n').entries()) {
    const kind = lineKind(rawLine, inCodeBlock);
    lines.push({
      number: index + 1,
      text: rawLine,
      kind,
    });

    if (rawLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }

  return {
    fileName,
    title,
    contents: normalized,
    lines,
  };
}

export async function loadOnboardingPanes(): Promise<OnboardingPane[]> {
  const docsRoot = path.join(process.cwd(), '..', 'docs', 'onboarding');

  return Promise.all(
    ONBOARDING_FILES.map(async (fileName) => {
      const contents = await readFile(path.join(docsRoot, fileName), 'utf8');
      return buildPane(fileName, contents);
    }),
  );
}
