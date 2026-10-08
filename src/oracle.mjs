// Trusted checks. This file lives outside the agent-controlled repo, and its
// hash is bound into every receipt, so editing it invalidates old results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { files } from './util.mjs';

const root = process.env.FEROX_REPO;
const specs = JSON.parse(await readFile(process.env.FEROX_CHECKS, 'utf8'));
const load = (file) => import(pathToFileURL(path.join(root, file)).href);

test('whole candidate typechecks under --strict', async () => {
  const sources = (await files(path.join(root, 'src')))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(root, 'src', file));
  const program = ts.createProgram(sources, {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  const host = { getCurrentDirectory: () => root, getCanonicalFileName: (x) => x, getNewLine: () => '\n' };
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, host));
});

test('date parser keeps timestamp behavior', async () => {
  const date = await load('src/date.ts');
  const parse = date.decodeDate || date.parseDate;
  assert.equal(parse('2026-01-01'), 1767225600000);
});

test('schedule still works', async () => {
  const schedule = await load('src/schedule.ts');
  assert.equal(schedule.nextDay('2026-01-01'), 1767312000000);
  assert.equal(schedule.dueDate('2026-01-30', 3), '2026-02-02');
});

test('pair budget stays within 100', async () => {
  const a = await load('src/feature-a.ts');
  const b = await load('src/feature-b.ts');
  assert.ok(a.budget + b.budget <= 100, `pair budget exceeded: ${a.budget}+${b.budget}`);
});

test('three-way budget stays within 100', async () => {
  const values = await Promise.all(['a', 'b', 'c'].map(async (x) => (await load(`src/triple-${x}.ts`)).budget));
  const total = values.reduce((sum, v) => sum + v, 0);
  assert.ok(total <= 100, `three-way budget exceeded: ${values.join('+')}`);
});

for (const [i, spec] of specs.entries()) {
  test(`acceptance ${i + 1}: ${spec.module}#${spec.export}`, async () => {
    const mod = await load(spec.module);
    const value = spec.call ? mod[spec.export](...spec.call) : mod[spec.export];
    assert.deepEqual(value, spec.equals);
  });
}
