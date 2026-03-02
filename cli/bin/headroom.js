#!/usr/bin/env node
import('../src/index.js').catch((error) => {
  console.error('Innies CLI failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
