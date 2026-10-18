// Lint gate for the class of bug that cost #218/#219 two large cleanup PRs:
// references to names nothing declares or imports, two declarations sharing a
// name, and dead code. Deliberately no style/formatting rules (see #220).
//
// Import awareness: plain no-undef can't tell that `import { foo } from
// './bar.js'` names something bar.js never exports. The `local` plugin below
// covers that for this project's relative ESM imports (import/no-unresolved +
// import/named semantics), using the parser ESLint already loaded, so the
// only thing CI has to fetch is ESLint itself.
import fs from 'node:fs';
import path from 'node:path';

const exportCache = new Map();

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
  }
}

const nameOf = (n) => (n.type === 'Identifier' ? n.name : n.value);

// Returns the Set of names `file` exports, or null when they can't be known
// statically (CommonJS, unparseable, or an unresolvable `export *`).
function exportsOf(file, parser, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  if (seen.has(file)) return new Set();
  seen.add(file);

  let ast;
  try {
    ast = parser.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  } catch {
    exportCache.set(file, null);
    return null;
  }

  let names = new Set();
  let sawEsm = false;
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') sawEsm = true;
    if (node.type === 'ExportDefaultDeclaration') {
      sawEsm = true;
      names.add('default');
    } else if (node.type === 'ExportNamedDeclaration') {
      sawEsm = true;
      const d = node.declaration;
      if (d?.id) names.add(d.id.name);
      if (d?.type === 'VariableDeclaration') for (const decl of d.declarations) patternNames(decl.id, names);
      for (const s of node.specifiers) names.add(nameOf(s.exported));
    } else if (node.type === 'ExportAllDeclaration') {
      sawEsm = true;
      if (node.exported) {
        names.add(nameOf(node.exported));
        continue;
      }
      const target = node.source.value.startsWith('.') ? resolveRelative(file, node.source.value) : null;
      const inner = target && exportsOf(target, parser, seen);
      if (!inner) {
        names = null;
        break;
      }
      for (const n of inner) if (n !== 'default') names.add(n);
    }
  }
  if (!sawEsm) names = null;
  exportCache.set(file, names);
  return names;
}

const localPlugin = {
  rules: {
    'import-resolve': {
      meta: {
        type: 'problem',
        docs: { description: 'Relative imports must resolve to a file that exports every imported name' },
        schema: [],
      },
      create(context) {
        const parser = context.languageOptions.parser;
        const filename = context.filename;

        function check(node, sourceNode, specifiers) {
          const spec = sourceNode?.value;
          if (typeof spec !== 'string' || !spec.startsWith('.')) return;
          const target = resolveRelative(filename, spec);
          if (!target) {
            context.report({ node: sourceNode, message: `Unable to resolve path to module '${spec}'.` });
            return;
          }
          if (!specifiers?.length) return;
          const exported = exportsOf(target, parser);
          if (!exported) return;
          for (const s of specifiers) {
            let wanted;
            if (s.type === 'ImportSpecifier') wanted = nameOf(s.imported);
            else if (s.type === 'ImportDefaultSpecifier') wanted = 'default';
            else if (s.type === 'ExportSpecifier') wanted = nameOf(s.local);
            else continue;
            if (!exported.has(wanted)) {
              context.report({ node: s, message: `'${wanted}' is not exported by '${spec}'.` });
            }
          }
        }

        return {
          ImportDeclaration: (node) => check(node, node.source, node.specifiers),
          ExportNamedDeclaration: (node) => node.source && check(node, node.source, node.specifiers),
          ExportAllDeclaration: (node) => check(node, node.source, null),
          ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source, null),
        };
      },
    },
  },
};

const nodeGlobals = Object.fromEntries(
  [
    'AbortController', 'AbortSignal', 'Blob', 'Buffer', 'BroadcastChannel', 'DOMException', 'Event', 'EventTarget',
    'FormData', 'Headers', 'Intl', 'MessageChannel', 'Request', 'Response', 'TextDecoder', 'TextEncoder', 'URL',
    'URLSearchParams', 'WebAssembly', 'atob', 'btoa', 'clearImmediate', 'clearInterval', 'clearTimeout', 'console',
    'crypto', 'fetch', 'global', 'globalThis', 'performance', 'process', 'queueMicrotask', 'setImmediate',
    'setInterval', 'setTimeout', 'structuredClone',
  ].map((name) => [name, 'readonly']),
);

const cjsGlobals = Object.fromEntries(
  ['require', 'module', 'exports', '__dirname', '__filename'].map((name) => [name, 'readonly']),
);

export default [
  {
    // Separate packages with their own toolchains and CI jobs (mcp-server has
    // its own package.json; sdk/ has the SDKs workflow).
    ignores: ['node_modules/**', '**/node_modules/**', 'coverage/**', 'mcp-server/**', 'sdk/**', 'backend/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { local: localPlugin },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'local/import-resolve': 'error',
    },
  },
  {
    // The few CommonJS files in the tree. Nothing imports any of them; they
    // are linted as what they are rather than reported as ESM errors.
    files: ['server.js', 'src/certification.js', 'src/questionTemplates.js', 'src/fraudScoring.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...nodeGlobals, ...cjsGlobals } },
  },
];
