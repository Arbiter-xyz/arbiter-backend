#!/usr/bin/env node
/**
 * Syntax-checks every .js file under src/ and scripts/ (#564).
 *
 * `node --check a.js b.js` only checks a.js (b.js becomes a script
 * argument), so this runs `node --check` once per file and fails if any
 * file fails to parse. Built-in modules only, and no shell globbing, so it
 * behaves the same on Windows.
 *
 *   node scripts/check-syntax.js [dir ...]   (default: src scripts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['src', 'scripts'];
const files = dirs.flatMap((d) => listJsFiles(path.resolve(ROOT, d))).sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`✗ ${path.relative(ROOT, file)}\n${result.stderr || result.error || ''}\n`);
  }
}

if (failed) {
  console.error(`Syntax check failed: ${failed} of ${files.length} file(s) do not parse.`);
  process.exit(1);
}
console.log(`Syntax check passed: ${files.length} file(s).`);
