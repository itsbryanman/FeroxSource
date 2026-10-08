import ts from 'typescript';
import path from 'node:path';

function modulePath(from, spec, known) {
  if (!spec.startsWith('.')) return `external:${spec}`;
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const raw = p.replace(/\.(js|mjs)$/, '');
  return [p, `${raw}.ts`, `${raw}.tsx`, `${p}/index.ts`].find((s) => known.has(s)) || `${raw}.ts`;
}
function parse(file, text, known) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defs = new Map();
  const imports = new Map();
  const importTexts = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = modulePath(file, statement.moduleSpecifier.text, known);
      importTexts.push(statement.getText(source));
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, `${target}#default`);
      const binding = clause?.namedBindings;
      if (binding && ts.isNamespaceImport(binding)) imports.set(binding.name.text, `${target}#*`);
      if (binding && ts.isNamedImports(binding))
        for (const entry of binding.elements)
          imports.set(entry.name.text, `${target}#${entry.propertyName?.text || entry.name.text}`);
      if (!clause) imports.set(`side-effect:${target}`, `${target}#*`);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          defs.set(declaration.name.text, { node: declaration, text: declaration.getText(source) });
        else defs.set('*', { node: statement, text: statement.getText(source) });
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) {
      defs.set(statement.name.text, { node: statement, text: statement.getText(source) });
    } else if (!ts.isEmptyStatement(statement)) {
      const prev = defs.get('*');
      defs.set('*', { node: source, text: `${prev?.text || ''}\n${statement.getText(source)}` });
    }
  }
  return { source, defs, imports, importTexts };
}

// What a reader of this symbol depends on. For a function with explicit parameter
// and return types that's the signature, so a body-only edit doesn't break callers.
// Anything with an inferred type falls back to the full text, which is conservative.
function signature(entry, source) {
  const node = entry.node;
  if (ts.isFunctionDeclaration(node) && node.type && node.parameters.every((p) => p.type)) {
    const mods = (ts.getModifiers(node) || []).map((m) => m.getText(source)).join(' ');
    const generics = node.typeParameters?.map((t) => t.getText(source)).join(',') ?? '';
    const params = node.parameters.map((p) => p.getText(source)).join(',');
    return `${mods} function<${generics}>(${params}):${node.type.getText(source)}`;
  }
  if (ts.isVariableDeclaration(node) && node.type) {
    const statement = node.parent?.parent;
    const exported = statement && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return `${exported ? 'export ' : ''}${node.name.getText(source)}:${node.type.getText(source)}`;
  }
  return entry.text;
}

/**
 * Symbol-level footprint of a change, from TypeScript syntax.
 *   writes: symbols whose text changed (used for write-write overlap)
 *   breaks: symbols removed or whose signature changed (what makes readers stale)
 *   reads:  symbols the changed code refers to, resolved through imports
 * Name-based, no type checker. It decides what to batch and what to replay.
 * It never decides what lands. The oracle does.
 */
export function analyze(before, after) {
  const known = new Set([...Object.keys(before), ...Object.keys(after)]);
  const writes = new Set();
  const breaks = new Set();
  const reads = new Set();
  const changedFiles = [];
  const symbols = [];

  for (const file of [...known].sort()) {
    if (before[file] === after[file]) continue;
    changedFiles.push(file);

    const huge = (before[file]?.length || 0) > 100_000 || (after[file]?.length || 0) > 100_000;
    if (!/\.tsx?$/.test(file) || huge) {
      writes.add(`${file}#*`);
      breaks.add(`${file}#*`);
      continue;
    }

    const a = parse(file, before[file] || '', known);
    const b = parse(file, after[file] || '', known);
    // a changed import can rebind any name in the file
    const importChanged = a.importTexts.join('\n') !== b.importTexts.join('\n');
    if (importChanged) writes.add(`${file}#*`);

    for (const name of new Set([...a.defs.keys(), ...b.defs.keys()])) {
      const old = a.defs.get(name);
      const fresh = b.defs.get(name);
      if (old?.text === fresh?.text && !importChanged) continue;

      writes.add(`${file}#${name}`);
      symbols.push({ file, symbol: name });
      if (old && (!fresh || signature(old, a.source) !== signature(fresh, b.source))) breaks.add(`${file}#${name}`);

      for (const [entry, parsed] of [
        [old, a],
        [fresh, b],
      ]) {
        if (!entry) continue;
        const walk = (node) => {
          if (ts.isIdentifier(node)) {
            if (parsed.imports.has(node.text)) reads.add(parsed.imports.get(node.text));
            else if (parsed.defs.has(node.text) && node.text !== name) reads.add(`${file}#${node.text}`);
          }
          ts.forEachChild(node, walk);
        };
        walk(entry.node);
        for (const [key, target] of parsed.imports) if (key.startsWith('side-effect:')) reads.add(target);
      }
    }
  }

  return {
    writes: [...writes].sort(),
    breaks: [...breaks].sort(),
    reads: [...reads].sort(),
    files: changedFiles,
    symbols,
  };
}

export function overlaps(a, b) {
  const [ap, an] = a.split('#');
  const [bp, bn] = b.split('#');
  return ap === bp && (an === bn || an === '*' || bn === '*');
}

// why two footprints interact. symmetric except for direction labels.
export function interactions(a, b) {
  const reasons = [];
  const aBreaks = a.breaks ?? a.writes;
  const bBreaks = b.breaks ?? b.writes;
  for (const x of a.writes) {
    for (const y of b.writes) if (overlaps(x, y)) reasons.push({ kind: 'write-write', writer: x, reader: y });
  }
  for (const x of aBreaks) {
    for (const y of b.reads) if (overlaps(x, y)) reasons.push({ kind: 'read-write', writer: x, reader: y });
  }
  for (const x of bBreaks) {
    for (const y of a.reads) if (overlaps(x, y)) reasons.push({ kind: 'write-read', writer: x, reader: y });
  }
  return reasons;
}
