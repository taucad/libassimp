#!/usr/bin/env node
/*
 * Copyright 2026 Richard Fontein
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Generates the public capability registry from checked compiler evidence and
 * a semantic override ledger. `--refresh-evidence` is the only mode that runs
 * Clang; ordinary generation and CI checks are deterministic Node-only work.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidencePath = `${root}scripts/assimp-capability-evidence.json`;
const overridesPath = `${root}scripts/assimp-capability-overrides.json`;
const outputPath = `${root}src/generated/assimp-capabilities.ts`;
const matrixPath = `${root}docs-site/content/docs/format-matrix.json`;
const buildDirectory = `${root}build/wasm-full`;
const containerRoot = '/src';
const propertyMethods = new Map([
  ['GetPropertyBool', 'boolean'],
  ['GetPropertyInteger', 'integer'],
  ['GetPropertyFloat', 'number'],
  ['GetPropertyString', 'string'],
  ['GetPropertyMatrix', 'matrix'],
  ['GetPropertyPointer', 'pointer'],
  ['GetPropertyCallback', 'callback'],
]);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const stableJson = (value) => `${JSON.stringify(value, undefined, 2)}\n`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sourcePath = (containerPath) => `${root}${containerPath.slice(containerRoot.length + 1)}`;
const sourceName = (path) => relative(root, path).replaceAll('\\', '/');
const formatTypescript = (source) =>
  execFileSync('pnpm', ['exec', 'oxfmt', `--stdin-filepath=${outputPath}`], {
    cwd: root,
    encoding: 'utf8',
    input: source,
  });

const cleanDoxygen = (comment) =>
  comment
    .replace(/^\/\*\*|\*\/$/gu, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/u, '').trim())
    .join(' ')
    .replace(/@(?:brief|note|warning|see)\s*/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/#(?=[A-Za-z_])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

const doxygenDescriptions = (path, symbolPattern) => {
  const descriptions = new Map();
  const source = readFileSync(path, 'utf8');
  const expression = new RegExp(`(\\/\\*\\*(?:(?!\\/\\*\\*)[\\s\\S])*?\\*\\/)\\s*${symbolPattern}`, 'gu');
  for (const match of source.matchAll(expression)) descriptions.set(match[2], cleanDoxygen(match[1]));
  return descriptions;
};

const conciseDescription = (description) => {
  const words = description
    .replace(/\bjust\b/giu, 'only')
    .replace(/\bused to\b/giu, 'used for')
    .split(/\s+/u);
  return words.length <= 90 ? words.join(' ') : `${words.slice(0, 90).join(' ')}…`;
};

const parseJsonDocuments = (text) => {
  const documents = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        documents.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (depth !== 0 || quoted) throw new Error('Clang produced incomplete AST JSON.');
  return documents;
};

const visit = (node, callback) => {
  callback(node);
  for (const child of node?.inner ?? []) visit(child, callback);
};

const first = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of node?.inner ?? []) {
    const match = first(child, predicate);
    if (match !== undefined) return match;
  }
  return undefined;
};

const literal = (node) => {
  if (node === undefined) return undefined;
  if (node.kind === 'CXXBoolLiteralExpr') return node.value;
  if (node.kind === 'IntegerLiteral') return Number(node.value);
  if (node.kind === 'FloatingLiteral') return Number(node.value);
  if (node.kind === 'StringLiteral') return JSON.parse(node.value);
  if (node.kind === 'UnaryOperator' && node.opcode === '-') {
    const value = literal(node.inner?.[0]);
    return typeof value === 'number' ? -value : undefined;
  }
  for (const child of node.inner ?? []) {
    const value = literal(child);
    if (value !== undefined) return value;
  }
  return undefined;
};

const locationOf = (node, fallback) => {
  const start = node?.range?.begin;
  const location = start?.expansionLoc ?? start?.spellingLoc ?? start;
  const file = location?.file?.startsWith(containerRoot)
    ? location.file.slice(containerRoot.length + 1)
    : fallback;
  const line =
    location?.line ??
    (typeof location?.offset === 'number'
      ? readFileSync(`${root}${file}`, 'utf8').slice(0, location.offset).split('\n').length
      : 0);
  return `${file}:${line}`;
};

const splitCommand = (command) => {
  const parts = command.trim().split(/\s+/u);
  const compiler = parts.findIndex((part) => part.endsWith('/em++'));
  if (compiler < 0) throw new Error(`No Emscripten compiler in: ${command}`);
  const args = [];
  for (let index = compiler + 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '-MD' || part === '-c') continue;
    if (part === '-MT' || part === '-MF' || part === '-o') {
      index += 1;
      continue;
    }
    args.push(part);
  }
  return args;
};

const compilerImage = () => readFileSync(`${root}emsdk-image.txt`, 'utf8').trim();

const runClang = (args, input) => {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volume',
      `${root.slice(0, -1)}:${containerRoot}`,
      '--workdir',
      containerRoot,
      '--interactive',
      compilerImage(),
      '/emsdk/upstream/emscripten/em++',
      ...args,
    ],
    { encoding: 'utf8', input, maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`Clang failed (${result.status ?? result.signal}):\n${result.stderr}`);
  }
  return result.stdout;
};

const ownerOf = (file) => {
  const marker = '/AssetLib/';
  const start = file.indexOf(marker);
  if (start >= 0) return file.slice(start + marker.length).split('/')[0];
  if (file.includes('/PostProcessing/')) return 'PostProcessing';
  return 'Common';
};

const stringLiteral = (node) => first(node, (candidate) => candidate?.kind === 'StringLiteral');

const propertyCalls = (ast, file) => {
  const properties = [];
  visit(ast, (node) => {
    if (node?.kind !== 'CXXMemberCallExpr') return;
    const member = node.inner?.find((child) => child.kind === 'MemberExpr');
    const kind = propertyMethods.get(member?.name);
    if (kind === undefined) return;
    const receiver = first(member, (candidate) => {
      const type = candidate?.type?.qualType ?? '';
      return type.includes('Importer *') || type.includes('ExportProperties *');
    });
    if (receiver === undefined) return;
    const phase = receiver.type.qualType.includes('Importer *') ? 'import' : 'export';
    const keyNode = stringLiteral(node.inner?.[1]);
    if (keyNode === undefined) {
      if (file === 'assimp/code/Common/Importer.cpp' || file === 'assimp/code/Common/Exporter.cpp') return;
      const reference = first(
        node.inner?.[1],
        (candidate) => candidate?.kind === 'DeclRefExpr' && candidate.referencedDecl?.kind === 'VarDecl',
      );
      if (reference === undefined) {
        throw new Error(`${member.name} has no compiler-visible string key at ${locationOf(node, file)}.`);
      }
      properties.push({
        keySymbol: reference.referencedDecl.name,
        phase,
        kind,
        default: literal(node.inner?.[2]),
        owner: ownerOf(file),
        source: locationOf(node, file),
      });
      return;
    }
    const nativeName = JSON.parse(keyNode.value);
    properties.push({
      nativeName,
      phase,
      kind,
      default: literal(node.inner?.[2]),
      owner: ownerOf(file),
      source: locationOf(node, file),
    });
  });
  return properties;
};

const macroEvidence = () => {
  const text = runClang(
    [
      '-dM',
      '-E',
      '-x',
      'c++',
      '-I/src/build/wasm-full/assimp/include',
      '-I/src/assimp/include',
      '-include',
      'assimp/config.h',
      '-',
    ],
    '\n',
  );
  const macros = new Map();
  for (const line of text.split('\n')) {
    const match = /^#define (AI_CONFIG_[A-Z0-9_]+) ("(?:[^"\\]|\\.)*")$/u.exec(line);
    if (match === null) continue;
    const [, symbol, encoded] = match;
    const nativeName = JSON.parse(encoded);
    const symbols = macros.get(nativeName) ?? [];
    symbols.push(symbol);
    macros.set(nativeName, symbols);
  }
  return macros;
};

const postProcessEvidence = () => {
  const text = runClang(
    [
      '-std=gnu++20',
      '-I/src/assimp/include',
      '-I/src/build/wasm-full/assimp/include',
      '-x',
      'c++',
      '-Xclang',
      '-ast-dump=json',
      '-Xclang',
      '-ast-dump-filter=aiPostProcessSteps',
      '-fsyntax-only',
      '-',
    ],
    '#include <assimp/postprocess.h>\n',
  );
  const steps = [];
  for (const document of parseJsonDocuments(text)) {
    visit(document, (node) => {
      if (node?.kind !== 'EnumConstantDecl' || !node.name?.startsWith('aiProcess_')) return;
      const value = first(node, (candidate) => candidate?.kind === 'ConstantExpr')?.value;
      if (value === undefined) throw new Error(`No constant value for ${node.name}.`);
      steps.push({ symbol: node.name, value: Number(value), source: 'assimp/include/assimp/postprocess.h' });
    });
  }
  return steps.sort((one, two) => one.value - two.value || one.symbol.localeCompare(two.symbol));
};

const sourceFingerprint = (paths, engineSha) => {
  const hash = createHash('sha256').update(engineSha);
  for (const path of [...paths].sort((one, two) => one.localeCompare(two))) {
    hash.update(sourceName(path)).update('\0').update(readFileSync(path));
  }
  return hash.digest('hex');
};

const sourceHashes = (paths) =>
  Object.fromEntries(
    [...paths]
      .sort((one, two) => one.localeCompare(two))
      .map((path) => [sourceName(path), sha256(readFileSync(path))]),
  );

const refreshEvidence = () => {
  if (!readFileSync(`${buildDirectory}/build.ninja`, 'utf8').includes('ASSIMP_BUILD_NO_GLTF1')) {
    throw new Error('Reconfigure wasm-full after applying the glTF 1 compile definitions.');
  }
  const database = JSON.parse(
    execFileSync('ninja', ['-C', buildDirectory, '-t', 'compdb'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const rows = database.filter(
    ({ command, file }) => file?.startsWith('/src/assimp/code/') && command.includes(' -c '),
  );
  const overrides = readJson(overridesPath);
  const propertyRows = rows.filter(({ file }) =>
    readFileSync(sourcePath(file), 'utf8').includes('GetProperty'),
  );
  const calls = [];
  for (const [index, row] of propertyRows.entries()) {
    const file = row.file.slice(5);
    const filters = overrides.astFilters?.[file] ?? [basename(row.file).replace(/\.[^.]+$/u, '')];
    const compileArgs = splitCommand(row.command);
    const rowCalls = [];
    for (const filter of filters) {
      const text = runClang([
        ...compileArgs,
        '-Xclang',
        '-ast-dump=json',
        '-Xclang',
        `-ast-dump-filter=${filter}`,
        '-fsyntax-only',
      ]);
      rowCalls.push(...parseJsonDocuments(text).flatMap((document) => propertyCalls(document, file)));
    }
    for (const symbol of new Set(
      rowCalls.flatMap(({ keySymbol }) => (keySymbol === undefined ? [] : [keySymbol])),
    )) {
      const constantText = runClang([
        ...compileArgs,
        '-Xclang',
        '-ast-dump=json',
        '-Xclang',
        `-ast-dump-filter=${symbol}`,
        '-fsyntax-only',
      ]);
      const declaration = parseJsonDocuments(constantText)
        .flatMap((document) => {
          const declarations = [];
          visit(document, (node) => {
            if (node?.kind === 'VarDecl' && node.name === symbol) declarations.push(node);
          });
          return declarations;
        })
        .at(0);
      const value = stringLiteral(declaration);
      if (value === undefined)
        throw new Error(`No compiler-visible string value for ${symbol} in ${row.file}.`);
      for (const call of rowCalls) {
        if (call.keySymbol === symbol) call.nativeName = JSON.parse(value.value);
      }
    }
    for (const call of rowCalls) {
      const evidence = { ...call };
      delete evidence.keySymbol;
      calls.push(evidence);
    }
    process.stderr.write(`\rClang capability evidence ${index + 1}/${propertyRows.length}`);
  }
  process.stderr.write('\n');

  const macros = macroEvidence();
  const byName = new Map();
  for (const call of calls) {
    const property = byName.get(call.nativeName) ?? {
      nativeName: call.nativeName,
      phases: [],
      kinds: [],
      defaults: [],
      owners: [],
      symbols: macros.get(call.nativeName) ?? [],
      sources: [],
    };
    for (const [field, value] of [
      ['phases', call.phase],
      ['kinds', call.kind],
      ['defaults', call.default],
      ['owners', call.owner],
      ['sources', call.source],
    ]) {
      if (value !== undefined && !property[field].some((item) => Object.is(item, value)))
        property[field].push(value);
    }
    byName.set(call.nativeName, property);
  }
  for (const [nativeName, symbols] of macros) {
    if (byName.has(nativeName)) continue;
    byName.set(nativeName, {
      nativeName,
      phases: [],
      kinds: [],
      defaults: [],
      owners: [],
      symbols,
      sources: ['assimp/include/assimp/config.h.in'],
    });
  }

  const matrix = readJson(matrixPath);
  const engineSha = execFileSync('git', ['-C', `${root}assimp`, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const sourcePaths = [
    ...new Set([
      ...propertyRows.map(({ file }) => sourcePath(file)),
      `${root}assimp/include/assimp/config.h.in`,
      `${root}assimp/include/assimp/postprocess.h`,
      `${root}variants.json`,
    ]),
  ];
  const evidence = {
    engineSha,
    sourceSha256: sourceFingerprint(sourcePaths, engineSha),
    sourceSha256ByPath: sourceHashes(sourcePaths),
    sources: sourcePaths.map(sourceName).sort((one, two) => one.localeCompare(two)),
    formats: {
      full: { import: matrix.full.import },
      importer: { import: matrix.importer.import },
      exporter: { import: matrix.exporter.import },
    },
    properties: [...byName.values()].sort((one, two) => one.nativeName.localeCompare(two.nativeName)),
    postProcess: postProcessEvidence(),
  };
  writeFileSync(evidencePath, stableJson(evidence));
  console.log(`wrote ${sourceName(evidencePath)} (${evidence.properties.length} properties)`);
};

const publicName = (symbol, nativeName) => {
  const words = (symbol ?? nativeName)
    .replace(/^AI_CONFIG_/u, '')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return (
    words[0] +
    words
      .slice(1)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join('')
  );
};

const bootstrapOverrides = () => {
  const evidence = readJson(evidencePath);
  const existing = readJson(overridesPath);
  const properties = { ...existing.properties };
  for (const property of evidence.properties) {
    const serializable = !property.kinds.some((kind) => kind === 'pointer' || kind === 'callback');
    const observed = property.phases.length > 0;
    properties[property.nativeName] ??= {
      publicName: publicName(property.symbols[0], property.nativeName),
      supported: serializable && observed,
      ...(!serializable
        ? { reason: 'Pointer and callback properties require a purpose-built safe bridge.' }
        : !observed
          ? { reason: 'The compiled engine does not read this configuration key.' }
          : {}),
    };
  }
  const postProcess = { ...existing.postProcess };
  for (const step of evidence.postProcess) {
    postProcess[step.symbol] ??= {
      publicName: publicName(step.symbol.replace(/^aiProcess_/u, ''), step.symbol),
    };
  }
  writeFileSync(overridesPath, stableJson({ ...existing, properties, postProcess }));
  console.log(`updated ${sourceName(overridesPath)}`);
};

const validateSourceEvidence = (evidence, engineSha, currentHashes) => {
  if (engineSha !== evidence.engineSha) {
    throw new Error(
      `Assimp moved ${evidence.engineSha} -> ${engineSha}; refresh and review compiler evidence.`,
    );
  }
  if (evidence.sourceSha256ByPath === undefined) {
    throw new Error('Capability evidence lacks per-source hashes; refresh compiler evidence.');
  }
  for (const path of evidence.sources) {
    const expected = evidence.sourceSha256ByPath[path];
    const current = currentHashes[path];
    if (expected !== current) {
      throw new Error(
        `Assimp capability source changed at ${path} (${expected ?? 'missing'} -> ${current ?? 'missing'}); refresh evidence.`,
      );
    }
  }
};

const validateOverrideCoverage = (evidence, overrides) => {
  const observed = new Map(evidence.properties.map((property) => [property.nativeName, property]));
  for (const [nativeName, property] of observed) {
    if (overrides.properties[nativeName] === undefined) {
      throw new Error(
        `Missing override for native property ${String(nativeName)} observed at ${String(property.sources.join(', '))}.`,
      );
    }
  }
  for (const nativeName of Object.keys(overrides.properties)) {
    if (!observed.has(nativeName)) {
      throw new Error(
        `Unused override for unknown native property ${nativeName} in scripts/assimp-capability-overrides.json.`,
      );
    }
  }
  const observedSteps = new Map(evidence.postProcess.map((step) => [step.symbol, step]));
  for (const [symbol, step] of observedSteps) {
    if (overrides.postProcess[symbol] === undefined) {
      throw new Error(
        `Missing override for post-process step ${String(symbol)} observed at ${String(step.source)}.`,
      );
    }
  }
  for (const symbol of Object.keys(overrides.postProcess)) {
    if (!observedSteps.has(symbol))
      throw new Error(`Unused override for unknown post-process step ${symbol}.`);
  }
};

const validateEvidence = (evidence, overrides) => {
  const engineSha = execFileSync('git', ['-C', `${root}assimp`, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const paths = evidence.sources.map((path) => `${root}${path}`);
  validateSourceEvidence(evidence, engineSha, sourceHashes(paths));
  const currentHash = sourceFingerprint(paths, engineSha);
  if (currentHash !== evidence.sourceSha256) {
    throw new Error(
      `Assimp capability source inventory changed (${evidence.sourceSha256} -> ${currentHash}); refresh evidence.`,
    );
  }
  validateOverrideCoverage(evidence, overrides);
};

const quote = (value) => JSON.stringify(value);
const tsType = (descriptor) => {
  if (descriptor.values !== undefined) return descriptor.values.map(quote).join(' | ');
  if (descriptor.kind === 'boolean') return 'boolean';
  if (descriptor.kind === 'integer' || descriptor.kind === 'number') return 'number';
  if (descriptor.kind === 'string') return 'string';
  if (descriptor.kind === 'matrix')
    return 'readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]';
  throw new Error(`Unsupported public property kind ${descriptor.kind}.`);
};

const descriptorFor = (evidence, override, descriptions) => {
  const nativeKind = override.nativeKind ?? (evidence.kinds.length === 1 ? evidence.kinds[0] : undefined);
  const kind = override.kind ?? nativeKind;
  const hasOverrideDefault = Object.hasOwn(override, 'default');
  const defaultValue = hasOverrideDefault
    ? override.default
    : evidence.defaults.length === 1
      ? evidence.defaults[0]
      : undefined;
  if (kind === undefined || nativeKind === undefined) {
    throw new Error(`Ambiguous kind for ${evidence.nativeName}: ${evidence.kinds.join(', ')}`);
  }
  if (defaultValue === undefined && !hasOverrideDefault) {
    throw new Error(
      `Ambiguous or missing default for ${evidence.nativeName} at ${evidence.sources.join(', ')}.`,
    );
  }
  return {
    publicName: override.publicName,
    nativeName: evidence.nativeName,
    kind,
    nativeKind,
    default: defaultValue,
    ...(override.defaultDescription === undefined ? {} : { defaultDescription: override.defaultDescription }),
    ...(override.minimum === undefined ? {} : { minimum: override.minimum }),
    ...(override.maximum === undefined ? {} : { maximum: override.maximum }),
    ...(override.values === undefined ? {} : { values: override.values }),
    ...(override.nativeValues === undefined ? {} : { nativeValues: override.nativeValues }),
    ...(override.applyDefault === undefined ? {} : { applyDefault: override.applyDefault }),
    owners: override.owners ?? evidence.owners,
    formats: override.formats ?? [],
    phases: override.phases ?? evidence.phases,
    description: conciseDescription(
      override.description ??
        evidence.symbols.map((symbol) => descriptions.get(symbol)).find(Boolean) ??
        evidence.symbols[0] ??
        evidence.nativeName,
    ),
    source: override.source ?? evidence.sources[0],
  };
};

const effectiveOverride = (property, overrides) => {
  const override = overrides.properties[property.nativeName];
  if (overrides.booleanProperties.includes(property.nativeName)) {
    const observedDefault = property.defaults.length === 1 ? property.defaults[0] : undefined;
    return {
      ...override,
      kind: 'boolean',
      nativeKind: 'integer',
      ...(Object.hasOwn(override, 'default')
        ? {}
        : observedDefault === undefined
          ? {}
          : { default: Boolean(observedDefault) }),
    };
  }
  const symbol = property.symbols[0] ?? '';
  const match = /^AI_CONFIG_IMPORT_([A-Z0-9]+)_(UNIT_SCALE_TO_METERS|UP_AXIS)$/u.exec(symbol);
  if (match === null) return override;
  const [, rawFormat, field] = match;
  const format = rawFormat.toLowerCase();
  const contract = overrides.unitAxis[format];
  if (contract === undefined) throw new Error(`Missing unit/axis contract override for ${symbol}.`);
  if (field === 'UNIT_SCALE_TO_METERS') {
    return {
      ...override,
      publicName: `${format}UnitScaleToMeters`,
      supported: true,
      phases: ['import'],
      kind: 'number',
      nativeKind: 'number',
      default: contract.unit,
      defaultDescription: contract.unitDefault,
      minimum: 0,
      description: `Meters represented by one ${format.toUpperCase()} source unit.`,
      owners: [rawFormat],
    };
  }
  return {
    ...override,
    publicName: `${format}UpAxis`,
    supported: true,
    phases: ['import'],
    kind: 'string',
    nativeKind: 'integer',
    default: contract.axis,
    values: ['x', 'y', 'z'],
    nativeValues: { x: 0, y: 1, z: 2 },
    description: `The ${format.toUpperCase()} source up axis.`,
    owners: [rawFormat],
  };
};

const renderInterface = (name, descriptors, exported = true) => {
  const fields = descriptors
    .map(
      (descriptor) =>
        `  /** ${descriptor.description.replaceAll('*/', '* /')} Default: ${JSON.stringify(descriptor.default)}. */\n` +
        `  readonly ${quote(descriptor.publicName)}?: ${tsType(descriptor)};`,
    )
    .join('\n');
  return `${exported ? 'export ' : ''}type ${name} = {\n${fields}\n};`;
};

const exportOptionsTypeName = (format) =>
  `Format${format.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])/gu, (_, _prefix, character) => character.toUpperCase())}ExportOptions`;

const renderGenerated = (evidence, overrides) => {
  const propertyDescriptions = doxygenDescriptions(
    `${root}assimp/include/assimp/config.h.in`,
    '#define\\s+(AI_CONFIG_[A-Z0-9_]+)',
  );
  const postProcessDescriptions = doxygenDescriptions(
    `${root}assimp/include/assimp/postprocess.h`,
    '(aiProcess_[A-Za-z0-9_]+)\\s*=',
  );
  const allProperties = evidence.properties.map((property) => ({
    evidence: property,
    override: effectiveOverride(property, overrides),
  }));
  const supported = allProperties
    .filter(({ override }) => override.supported !== false)
    .flatMap(({ evidence: item, override }) =>
      (override.variants ?? [override]).map((variant) =>
        descriptorFor(item, { ...override, ...variant }, propertyDescriptions),
      ),
    );
  const importOptions = supported
    .filter((descriptor) => descriptor.phases.includes('import'))
    .sort((one, two) => one.publicName.localeCompare(two.publicName));
  const exportOptions = Object.fromEntries(overrides.formats.order.map((format) => [format, []]));
  for (const descriptor of supported) {
    if (!descriptor.phases.includes('export')) continue;
    for (const format of descriptor.formats) exportOptions[format].push(descriptor);
  }
  for (const [format, route] of Object.entries(overrides.formats.routes)) {
    for (const option of route.options ?? []) exportOptions[format].push(option);
    exportOptions[format].sort((one, two) => one.publicName.localeCompare(two.publicName));
  }

  const steps = evidence.postProcess.map((step) => ({
    ...step,
    ...overrides.postProcess[step.symbol],
    description: conciseDescription(
      overrides.postProcess[step.symbol].description ??
        postProcessDescriptions.get(step.symbol) ??
        step.symbol,
    ),
  }));

  const assertUnique = (label, values) => {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value)) throw new Error(`Duplicate ${label} public name ${value}.`);
      seen.add(value);
    }
  };
  assertUnique(
    'import option',
    importOptions.map(({ publicName: name }) => name),
  );
  assertUnique(
    'post-process',
    steps.map(({ publicName: name }) => name),
  );
  for (const [format, descriptors] of Object.entries(exportOptions)) {
    assertUnique(
      `${format} export option`,
      descriptors.map(({ publicName: name }) => name),
    );
  }
  const stepNames = new Set(steps.map(({ publicName: name }) => name));
  for (const name of overrides.defaultPostProcess) {
    if (!stepNames.has(name)) throw new Error(`Unknown default post-process step ${name}.`);
  }
  const imports = evidence.formats;
  const formatValues = (formats) => JSON.stringify(formats, undefined, 2);
  const formatType = (formats) => formats.map(({ id }) => quote(id)).join(' | ');
  const optionTypes = overrides.formats.order
    .map((format) => renderInterface(exportOptionsTypeName(format), exportOptions[format], false))
    .join('\n\n');
  const exportMapFields = overrides.formats.order
    .map((format) => `  readonly ${quote(format)}: ${exportOptionsTypeName(format)};`)
    .join('\n');
  const routes = overrides.formats.order.map((id) => ({ id, ...overrides.formats.routes[id] }));
  const internalDescriptorsByFormat = Object.fromEntries(
    overrides.formats.order.map((format) => [
      format,
      Object.fromEntries(exportOptions[format].map((descriptor) => [descriptor.publicName, descriptor])),
    ]),
  );
  const internalDescriptorFields = new Set([
    'publicName',
    'nativeName',
    'nativeKind',
    'nativeValues',
    'applyDefault',
    'owners',
    'formats',
    'phases',
    'source',
  ]);
  const publicDescriptor = (descriptor) =>
    Object.fromEntries(Object.entries(descriptor).filter(([name]) => !internalDescriptorFields.has(name)));
  const publicDescriptorsByFormat = Object.fromEntries(
    overrides.formats.order.map((format) => [
      format,
      Object.fromEntries(
        exportOptions[format].map((descriptor) => [descriptor.publicName, publicDescriptor(descriptor)]),
      ),
    ]),
  );
  const exportInfo = routes.map(({ id, extension, description }) => ({
    id,
    extension,
    description,
    exportOptions: publicDescriptorsByFormat[id],
  }));
  const importerExportInfo = exportInfo.filter(({ id }) => overrides.formats.importer.includes(id));
  const internalImportDescriptors = Object.fromEntries(
    importOptions.map((descriptor) => [descriptor.publicName, descriptor]),
  );
  const importDescriptors = Object.fromEntries(
    importOptions.map((descriptor) => [descriptor.publicName, publicDescriptor(descriptor)]),
  );
  const internalStepDescriptors = Object.fromEntries(
    steps.map(({ publicName: name, symbol, value, description, conflicts = [] }) => [
      name,
      { symbol, value, description, conflicts, source: 'assimp/include/assimp/postprocess.h' },
    ]),
  );
  const stepDescriptors = Object.fromEntries(
    steps.map(({ publicName: name, description, conflicts = [] }) => [name, { description, conflicts }]),
  );

  return `/* This file is generated by scripts/generate-assimp-capabilities.mjs. Do not edit. */

/** A canonical import or export format. @public */
export type FormatInfo<Format extends string = string> = {
  readonly id: Format;
  readonly extension: string;
  readonly description: string;
};

/** Serializable option metadata used by validation and dynamic UIs. @public */
export type OptionDescriptor = Readonly<{
  kind: 'boolean' | 'integer' | 'number' | 'string' | 'matrix';
  default: boolean | number | string | readonly number[] | null;
  defaultDescription?: string;
  minimum?: number;
  maximum?: number;
  values?: readonly (boolean | number | string)[];
  description: string;
}>;

/** Serializable metadata for one named post-process step. @public */
export type PostProcessDescriptor = Readonly<{
  description: string;
  conflicts: readonly string[];
}>;

${renderInterface('ImportOptions', importOptions)}

${optionTypes}

export type ExportOptionsByFormat = {
${exportMapFields}
};

export type AllExportFormat = keyof ExportOptionsByFormat;
export type ImporterExportFormat = ${overrides.formats.importer.map(quote).join(' | ')};
export type ExportOptionsFor<Format extends AllExportFormat> = ExportOptionsByFormat[Format];
export type ExportOptionDescriptorsFor<Format extends AllExportFormat> = Readonly<{
  [Key in keyof ExportOptionsByFormat[Format]]-?: OptionDescriptor;
}>;

export type PostProcessStep = ${steps.map(({ publicName: name }) => quote(name)).join(' | ')};

export const defaultPostProcess = ${JSON.stringify(overrides.defaultPostProcess)} as const satisfies readonly PostProcessStep[];

export const fullImportFormats = ${formatValues(imports.full.import)} as const;
export const importerImportFormats = ${formatValues(imports.importer.import)} as const;
export const exporterImportFormats = ${formatValues(imports.exporter.import)} as const;
export const allExportFormats = ${JSON.stringify(exportInfo, undefined, 2)} as const;
export const importerExportFormats = ${JSON.stringify(importerExportInfo, undefined, 2)} as const;

export type FullImportFormat = ${formatType(imports.full.import)};
export type ImporterImportFormat = ${formatType(imports.importer.import)};
export type ExporterImportFormat = ${formatType(imports.exporter.import)};

export type ImportFormatInfo<Format extends string> = Format extends string ? FormatInfo<Format> : never;
export type ExportFormatInfo<Format extends AllExportFormat> = Format extends AllExportFormat
  ? FormatInfo<Format> & { readonly exportOptions: ExportOptionDescriptorsFor<Format> }
  : never;

export type ConversionEdgeFor<ImportFormat extends string, ExportFormat extends AllExportFormat> = {
  [From in ImportFormat]: {
    [To in Exclude<ExportFormat, From>]: Readonly<{ from: From; to: To }>;
  }[Exclude<ExportFormat, From>];
}[ImportFormat];

const isSameFormat = (one: string, two: string): boolean => one === two;

const createConversionEdges = <ImportFormat extends string, ExportFormat extends AllExportFormat>(
  imports: readonly FormatInfo<ImportFormat>[],
  exports: readonly FormatInfo<ExportFormat>[],
): readonly ConversionEdgeFor<ImportFormat, ExportFormat>[] =>
  imports.flatMap(({ id: from }) => exports.filter(({ id: to }) => !isSameFormat(from, to)).map(({ id: to }) => ({ from, to }))) as unknown as readonly ConversionEdgeFor<ImportFormat, ExportFormat>[];

export const fullConversionEdges = createConversionEdges(fullImportFormats, allExportFormats);
export const importerConversionEdges = createConversionEdges(importerImportFormats, importerExportFormats);
export const exporterConversionEdges = createConversionEdges(exporterImportFormats, allExportFormats);

const importOptionDescriptors = ${JSON.stringify(importDescriptors, undefined, 2)} as const;
const postProcessDescriptors = ${JSON.stringify(stepDescriptors, undefined, 2)} as const;

/** Native maps consumed only by the handwritten validator and bridge. @internal */
export const internalImportOptionDescriptors = ${JSON.stringify(internalImportDescriptors, undefined, 2)} as const;
/** @internal */
export const internalExportOptionDescriptors = ${JSON.stringify(internalDescriptorsByFormat, undefined, 2)} as const;
/** @internal */
export const internalPostProcessDescriptors = ${JSON.stringify(internalStepDescriptors, undefined, 2)} as const;
/** @internal */
export const internalCanonicalExportRoutes = ${JSON.stringify(routes, undefined, 2)} as const;

const keyed = <const Values extends readonly FormatInfo[]>(values: Values) =>
  Object.fromEntries(values.map((value) => [value.id, value])) as {
    readonly [Key in Values[number]['id']]: Extract<Values[number], { readonly id: Key }>;
  };

export const fullAssimpCapabilities = {
  import: keyed(fullImportFormats),
  export: keyed(allExportFormats),
  importOptions: importOptionDescriptors,
  postProcess: postProcessDescriptors,
} as const;

export const importerAssimpCapabilities = {
  import: keyed(importerImportFormats),
  export: keyed(importerExportFormats),
  importOptions: importOptionDescriptors,
  postProcess: postProcessDescriptors,
} as const;

export const exporterAssimpCapabilities = {
  import: keyed(exporterImportFormats),
  export: keyed(allExportFormats),
  importOptions: importOptionDescriptors,
  postProcess: postProcessDescriptors,
} as const;
`;
};

const generate = (check) => {
  const evidence = readJson(evidencePath);
  const overrides = readJson(overridesPath);
  validateEvidence(evidence, overrides);
  const generated = formatTypescript(renderGenerated(evidence, overrides));
  if (check) {
    const current = readFileSync(outputPath, 'utf8');
    if (current !== generated)
      throw new Error(`${sourceName(outputPath)} is stale; run pnpm generate:capabilities.`);
    console.log(`${sourceName(outputPath)} is current (${sha256(generated)}).`);
    return;
  }
  mkdirSync(new URL('../src/generated/', import.meta.url), { recursive: true });
  writeFileSync(outputPath, generated);
  console.log(`wrote ${sourceName(outputPath)} (${sha256(generated)})`);
};

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--refresh-evidence')) refreshEvidence();
  else if (args.has('--bootstrap-overrides')) bootstrapOverrides();
  else generate(args.has('--check'));
}

export { validateOverrideCoverage, validateSourceEvidence };
