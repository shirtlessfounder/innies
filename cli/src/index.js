#!/usr/bin/env node
import { runLogin } from './commands/login.js';
import { runDoctor } from './commands/doctor.js';
import { runClaude } from './commands/claude.js';
import { runCodex } from './commands/codex.js';
import { runLinkClaude } from './commands/link.js';
import { fail, printUsage } from './utils.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    printUsage();
    return;
  }

  if (command === 'login') {
    await runLogin(args.slice(1));
    return;
  }

  if (command === 'doctor') {
    await runDoctor();
    return;
  }

  if (command === 'claude') {
    const cmdArgs = args.slice(1);
    const sepIdx = cmdArgs.indexOf('--');
    const passArgs = sepIdx === -1 ? cmdArgs : cmdArgs.slice(sepIdx + 1);
    await runClaude(passArgs);
    return;
  }

  if (command === 'codex') {
    const cmdArgs = args.slice(1);
    const sepIdx = cmdArgs.indexOf('--');
    const passArgs = sepIdx === -1 ? cmdArgs : cmdArgs.slice(sepIdx + 1);
    await runCodex(passArgs);
    return;
  }

  if (command === 'link') {
    const target = args[1];
    if (target === 'claude') {
      await runLinkClaude();
      return;
    }
    fail('Unknown link target. Supported: claude');
  }

  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
