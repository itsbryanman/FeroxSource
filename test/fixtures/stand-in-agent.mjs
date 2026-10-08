#!/usr/bin/env node
// Test stand-in for a CLI coding agent. Not an LLM. It follows the same
// contract the real adapter uses: prompt on stdin, edit files in cwd, exit 0.
// Lets the test suite cover the agent plumbing without an API key.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
if (process.env.STAND_IN_FAIL) {
  console.error('stand-in agent told to fail');
  process.exit(3);
}
if (!prompt.includes('daysBetween')) {
  console.error('unexpected task');
  process.exit(2);
}
const date = readFileSync('src/date.ts', 'utf8');
const parser = /export function (\w+)\(value: string\): number/.exec(date)[1];
mkdirSync('src', { recursive: true });
writeFileSync('src/range.ts', [
  `import { ${parser} } from "./date.ts";`,
  '',
  'export function daysBetween(start: string, end: string): number {',
  `  return Math.round((${parser}(end) - ${parser}(start)) / 86_400_000);`,
  '}',
  '',
].join('\n'));
console.log(JSON.stringify({ result: `wrote src/range.ts using ${parser}`, replay: prompt.includes('This is a replay') }));
