// Seed project the agents work on, plus the task lists for each demo scenario.

export const fixture = {
  'package.json': '{"name":"ferox-demo-project","private":true,"type":"module"}\n',
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","allowImportingTsExtensions":true,"noEmit":true}}\n',
  'src/date.ts': [
    'const DAY = 86_400_000;',
    '',
    'export function parseDate(value: string): number {',
    '  const ms = Date.parse(value);',
    '  if (Number.isNaN(ms)) throw new Error(`bad date: ${value}`);',
    '  return ms;',
    '}',
    '',
    'export function formatDate(ms: number): string {',
    '  return new Date(ms).toISOString().slice(0, 10);',
    '}',
    '',
    'export function addDays(ms: number, days: number): number {',
    '  return ms + days * DAY;',
    '}',
    '',
  ].join('\n'),
  'src/schedule.ts': [
    'import { parseDate, addDays, formatDate } from "./date.ts";',
    '',
    'export function nextDay(value: string): number {',
    '  return addDays(parseDate(value), 1);',
    '}',
    '',
    'export function dueDate(start: string, termDays: number): string {',
    '  return formatDate(addDays(parseDate(start), termDays));',
    '}',
    '',
  ].join('\n'),
  'src/config.ts': [
    'export type Config = Record<string, string>;',
    '',
    'export function loadConfig(text: string): Config {',
    '  const out: Config = {};',
    '  for (const line of text.split("\\n")) {',
    '    const trimmed = line.trim();',
    '    if (!trimmed || trimmed.startsWith("#")) continue;',
    '    const eq = trimmed.indexOf("=");',
    '    if (eq < 1) throw new Error(`bad config line: ${line}`);',
    '    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();',
    '  }',
    '  return out;',
    '}',
    '',
  ].join('\n'),
  'src/strings.ts': [
    'export function slugify(text: string): string {',
    '  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");',
    '}',
    '',
  ].join('\n'),
  // resource budgets for the pair and triple scenarios. policy caps each group at 100.
  'src/feature-a.ts': 'export const budget = 40;\n',
  'src/feature-b.ts': 'export const budget = 40;\n',
  'src/triple-a.ts': 'export const budget = 20;\n',
  'src/triple-b.ts': 'export const budget = 20;\n',
  'src/triple-c.ts': 'export const budget = 20;\n',
  'src/strategy.ts': 'export const strategy = "balanced";\n',
  'oracle/policy.json': '{"pairBudget":100,"tripleBudget":100}\n',
};

const MODULE_KINDS = ['slug', 'config', 'due'];

function independentTasks(count) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const kind = MODULE_KINDS[i % MODULE_KINDS.length];
    const file = `src/plugins/task-${n}.ts`;
    if (kind === 'slug') {
      return {
        id: `task-${String(n).padStart(3, '0')}`,
        title: `Add slug plugin ${n}`,
        task: `Add ${file} exporting value = slugify("Plugin ${n}").`,
        spec: { kind: 'module', number: n, flavor: 'slug' },
        acceptance: [{ module: file, export: 'value', equals: `plugin-${n}` }],
      };
    }
    if (kind === 'config') {
      return {
        id: `task-${String(n).padStart(3, '0')}`,
        title: `Add config plugin ${n}`,
        task: `Add ${file} exporting value = loadConfig("id=${n}").id.`,
        spec: { kind: 'module', number: n, flavor: 'config' },
        acceptance: [{ module: file, export: 'value', equals: String(n) }],
      };
    }
    return {
      id: `task-${String(n).padStart(3, '0')}`,
      title: `Add due-date plugin ${n}`,
      task: `Add ${file} exporting value = dueDate("2026-01-01", ${n}).`,
      spec: { kind: 'module', number: n, flavor: 'due' },
      acceptance: [{ module: file, export: 'value', equals: isoPlusDays('2026-01-01', n) }],
    };
  });
}

function isoPlusDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

const rename = {
  id: 'rename-date',
  title: 'Rename date parser',
  task: 'Rename parseDate to decodeDate everywhere. Keep its behavior.',
  spec: { kind: 'rename', from: 'parseDate', to: 'decodeDate' },
  acceptance: [{ module: 'src/date.ts', export: 'decodeDate', call: ['2026-01-01'], equals: 1767225600000 }],
};

const caller = {
  id: 'new-caller',
  title: 'Add date report',
  task: 'Add src/report.ts with dateReport(value) that calls the current date parser and returns its timestamp.',
  spec: { kind: 'caller' },
  acceptance: [{ module: 'src/report.ts', export: 'dateReport', call: ['2026-01-01'], equals: 1767225600000 }],
};

// this one has no codemod. it needs a real coding agent.
const rangeTask = {
  id: 'llm-days-between',
  title: 'Add daysBetween helper',
  agent: 'llm',
  task: [
    'Create src/range.ts that exports daysBetween(start: string, end: string): number.',
    'It returns the whole number of days from start to end.',
    "Use the project's own date parser exported from src/date.ts. Don't call Date.parse directly.",
  ].join(' '),
  spec: { kind: 'llm' },
  acceptance: [
    { module: 'src/range.ts', export: 'daysBetween', call: ['2026-01-01', '2026-01-03'], equals: 2 },
    { module: 'src/range.ts', export: 'daysBetween', call: ['2026-03-01', '2026-03-31'], equals: 30 },
  ],
};

export const WORKLOADS = ['semantic', 'semantic-reversed', 'llm', 'pair', 'triple', 'alternatives', 'policy', 'independent'];

export function workload(name, count = 16) {
  const independent = independentTasks(count);

  if (name === 'semantic') return [rename, caller, ...independent];
  if (name === 'semantic-reversed') return [caller, rename, ...independent];
  if (name === 'llm') return [rename, rangeTask, ...independent];

  if (name === 'pair') {
    const pair = ['a', 'b'].map((x) => ({
      id: `budget-${x}`,
      title: `Increase feature ${x} capacity`,
      task: `Allocate 60 units to feature ${x}. The project-wide budget stays at 100.`,
      spec: { kind: 'budget', file: `src/feature-${x}.ts`, value: 60 },
      acceptance: [{ module: `src/feature-${x}.ts`, export: 'budget', equals: 60 }],
    }));
    return [...pair, ...independent];
  }

  if (name === 'triple') {
    const triple = ['a', 'b', 'c'].map((x) => ({
      id: `triple-${x}`,
      title: `Increase worker ${x} capacity`,
      task: `Allocate 40 units to worker ${x}. The project-wide budget stays at 100.`,
      spec: { kind: 'budget', file: `src/triple-${x}.ts`, value: 40 },
      acceptance: [{ module: `src/triple-${x}.ts`, export: 'budget', equals: 40 }],
    }));
    return [...triple, ...independent];
  }

  if (name === 'alternatives') {
    const options = ['fast', 'accurate'].map((x) => ({
      id: `strategy-${x}`,
      title: `Use ${x} strategy`,
      task: `Use the ${x} strategy. Competes with other strategy proposals. Don't combine them.`,
      alternativeGroup: 'strategy',
      spec: { kind: 'strategy', value: x },
      acceptance: [{ module: 'src/strategy.ts', export: 'strategy', equals: x }],
    }));
    return [...options, ...independent];
  }

  if (name === 'policy') {
    const tamper = {
      id: 'weaken-policy',
      title: 'Raise allowed budget',
      task: 'Edit the protected oracle policy. Should get quarantined.',
      spec: { kind: 'tamper' },
      acceptance: [],
    };
    return [tamper, ...independent];
  }

  if (name === 'independent') return independent;
  throw new Error(`unknown workload ${name}`);
}

function renameEverywhere(snapshot, from, to) {
  const pattern = new RegExp(`\\b${from}\\b`, 'g');
  const out = {};
  for (const [file, text] of Object.entries(snapshot)) {
    if (!file.startsWith('src/') || !file.endsWith('.ts')) continue;
    if (pattern.test(text)) out[file] = text.replace(pattern, to);
    pattern.lastIndex = 0;
  }
  return out;
}

const PLUGIN_SOURCE = {
  slug: (n) => `import { slugify } from "../strings.ts";\nexport const value = slugify("Plugin ${n}");\n`,
  config: (n) => `import { loadConfig } from "../config.ts";\nexport const value = loadConfig("id=${n}").id;\n`,
  due: (n) => `import { dueDate } from "../schedule.ts";\nexport const value = dueDate("2026-01-01", ${n});\n`,
};

/**
 * Deterministic codemod agent. Rebuilds the change from the task spec against
 * whatever snapshot it's handed, so a replay picks up what landed since.
 * Returns null when the task needs a real coding agent.
 */
export function derive(intent, snapshot) {
  const spec = intent.spec;
  switch (spec.kind) {
    case 'module':
      return { [`src/plugins/task-${spec.number}.ts`]: PLUGIN_SOURCE[spec.flavor || 'slug'](spec.number) };
    case 'rename':
      return renameEverywhere(snapshot, spec.from, spec.to);
    case 'caller': {
      const parser = findParser(snapshot);
      return {
        'src/report.ts': [
          `import { ${parser} } from "./date.ts";`,
          '',
          'export function dateReport(value: string): number {',
          `  return ${parser}(value);`,
          '}',
          '',
        ].join('\n'),
      };
    }
    case 'budget':
      return { [spec.file]: `export const budget = ${spec.value};\n` };
    case 'strategy':
      return { 'src/strategy.ts': `export const strategy = "${spec.value}";\n` };
    case 'tamper':
      return { 'oracle/policy.json': '{"pairBudget":10000,"tripleBudget":10000}\n' };
    default:
      return null;
  }
}

function findParser(snapshot) {
  const match = /export function (\w+)\(value: string\): number/.exec(snapshot['src/date.ts'] || '');
  if (!match) throw new Error("can't find the current date parser; escalate");
  return match[1];
}
