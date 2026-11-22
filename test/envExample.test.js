import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReferences, parseEnvExample, diffEnv } from '../scripts/check-env-example.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_ENV_RE = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])/g;

test('the repo’s .env.example documents every process.env reference in src/', () => {
  const result = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/check-env-example.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('collectReferences finds dotted and bracketed process.env reads', () => {
  const files = { 'a.js': "const x = process.env.FOO_BAR; const y = process.env['BAZ']; process.env.npm_package_version;" };
  const refs = collectReferences(Object.keys(files), PROCESS_ENV_RE, (f) => files[f]);
  assert.deepEqual([...refs.keys()].sort(), ['BAZ', 'FOO_BAR']);
});

test('parseEnvExample counts commented examples as documented but not active', () => {
  const { documented, active } = parseEnvExample('# comment\nFOO=1\n# ARBITER_ENV=\nBAR=\n#not an entry\n');
  assert.deepEqual([...documented].sort(), ['ARBITER_ENV', 'BAR', 'FOO']);
  assert.deepEqual([...active].sort(), ['BAR', 'FOO']);
});

test('diffEnv reports missing and stale variables', () => {
  const referenced = new Map([
    ['REDIS_URL', new Set(['src/config.js'])],
    ['ORACLE_CONTRACT_ID', new Set(['src/config.js'])],
  ]);
  const alsoRead = new Map([['NODE_ENV', new Set(['src/securityPosture.js'])]]);
  const { documented, active } = parseEnvExample('REDIS_URL=\nNODE_ENV=\nSTELLAR_NETWORK=testnet\n');
  assert.deepEqual(diffEnv({ referenced, alsoRead, documented, active }), {
    missing: ['ORACLE_CONTRACT_ID'],
    stale: ['STELLAR_NETWORK'],
  });
});
