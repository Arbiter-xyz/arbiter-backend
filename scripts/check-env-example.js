#!/usr/bin/env node
/**
 * Fails when .env.example drifts from the environment variables the code
 * actually reads (#224):
 *
 *   - missing: a process.env.X reference under src/ (or in the root
 *     server.js) with no `X=` or `# X=` line in .env.example.
 *   - stale: an uncommented `X=` entry in .env.example that nothing reads
 *     any more. Variables only read through an injected env object (e.g.
 *     securityPosture.js's `env.NODE_ENV`) count as read.
 *
 * Built-in modules only, so CI can run it without `npm ci`:
 *   node scripts/check-env-example.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROCESS_ENV_RE = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])/g;
const ENV_PARAM_RE = /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])/g;
const ENTRY_RE = /^(#\s*)?([A-Z][A-Z0-9_]*)=/;

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** Map of variable name -> files reading it via `re`. */
export function collectReferences(files, re, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const refs = new Map();
  for (const file of files) {
    for (const match of readFile(file).matchAll(re)) {
      const name = match[1] || match[2];
      if (!refs.has(name)) refs.set(name, new Set());
      refs.get(name).add(file);
    }
  }
  return refs;
}

/** `{ documented, active }`: every `X=`/`# X=` name, and the uncommented subset. */
export function parseEnvExample(text) {
  const documented = new Set();
  const active = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = ENTRY_RE.exec(line.trim());
    if (!match) continue;
    documented.add(match[2]);
    if (!match[1]) active.add(match[2]);
  }
  return { documented, active };
}

export function diffEnv({ referenced, alsoRead, documented, active }) {
  const missing = [...referenced.keys()].filter((name) => !documented.has(name)).sort();
  const stale = [...active].filter((name) => !referenced.has(name) && !alsoRead.has(name)).sort();
  return { missing, stale };
}

function main() {
  const files = [...listJsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'server.js')].filter((f) => fs.existsSync(f));
  const referenced = collectReferences(files, PROCESS_ENV_RE);
  const alsoRead = collectReferences(files, ENV_PARAM_RE);
  const { documented, active } = parseEnvExample(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
  const { missing, stale } = diffEnv({ referenced, alsoRead, documented, active });

  const rel = (f) => path.relative(ROOT, f);
  for (const name of missing) {
    console.error(`missing from .env.example: ${name} (read in ${[...referenced.get(name)].map(rel).join(', ')})`);
  }
  for (const name of stale) {
    console.error(`stale in .env.example: ${name} is not read anywhere in src/ or server.js`);
  }
  if (missing.length || stale.length) {
    console.error(`\n.env.example is out of sync: ${missing.length} missing, ${stale.length} stale.`);
    process.exit(1);
  }
  console.log(`.env.example documents all ${referenced.size} environment variables read by the code.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
