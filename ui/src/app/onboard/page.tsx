import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PaneCopyButton } from './PaneCopyButton';
import { LandingHeroHeader } from '../../components/LandingHeroHeader';
import landingStyles from '../page.module.css';
import styles from './page.module.css';

type PaneLineKind =
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

type PaneLine = {
  number: number;
  text: string;
  kind: PaneLineKind;
};

type OnboardingPane = {
  fileName: string;
  title: string;
  contents: string;
  lines: PaneLine[];
};

const ONBOARDING_FILES = [
  'CLAUDE_CODEX_OAUTH_TOKENS.md',
  'CLI_ONBOARDING.md',
  'OPENCLAW_ONBOARDING.md',
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

function buildPane(fileName: string, contents: string): OnboardingPane {
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

async function loadOnboardingPanes(): Promise<OnboardingPane[]> {
  const docsRoot = path.join(process.cwd(), '..', 'docs', 'onboarding');

  return Promise.all(
    ONBOARDING_FILES.map(async (fileName) => {
      const contents = await readFile(path.join(docsRoot, fileName), 'utf8');
      return buildPane(fileName, contents);
    }),
  );
}

export default async function OnboardPage() {
  const panes = await loadOnboardingPanes();

  return (
    <main className={landingStyles.page}>
      <div className={landingStyles.shell}>
        <div className={landingStyles.console}>
          <LandingHeroHeader
            promptMode="analytics"
            title="innies onboarding"
            analyticsPromptLabel="message"
            analyticsPromptLinkLabel="@shirtessfounder"
            analyticsPromptLinkHref="https://t.me/shirtlessfounder"
            analyticsPromptSuffix="on telegram with your oauth tokens to onboard"
          />

          <section className={styles.workspaceSection}>
            <div className={styles.workspaceMeta}>
              <span className={styles.workspaceLabel}>ONBOARDING WORKSPACE</span>
              <span className={styles.workspaceHint}>3 GUIDES LOADED · SCROLL EACH PANE INDEPENDENTLY</span>
            </div>

            <div className={styles.workspaceGrid}>
              {panes.map((pane) => (
                <article key={pane.fileName} className={styles.pane}>
                  <div className={styles.paneChrome}>
                    <div className={styles.paneLights} aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className={styles.paneTab}>{pane.fileName}</div>
                    <div className={styles.paneChromeActions}>
                      <div className={styles.paneCount}>{pane.lines.length} lines</div>
                      <PaneCopyButton fileName={pane.fileName} contents={pane.contents} />
                    </div>
                  </div>

                  <div className={styles.paneBody}>
                    <div className={styles.paneRows}>
                      {pane.lines.map((line) => (
                        <div key={`${pane.fileName}-${line.number}`} className={styles.paneLine}>
                          <span className={styles.lineNumber}>{line.number}</span>
                          <span
                            className={[
                              styles.lineText,
                              styles[`line_${line.kind}`],
                            ].filter(Boolean).join(' ')}
                          >
                            {line.text.length > 0 ? line.text : ' '}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
