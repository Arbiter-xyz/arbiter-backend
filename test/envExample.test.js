import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every process.env.X variable referenced in src/*.js is documented in .env.example (#224)', () => {
  const envExample = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');
  const documentedVars = new Set(
    [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );

  const srcDir = path.join(ROOT_DIR, 'src');
  const referencedVars = new Set();
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(srcDir, entry), 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      referencedVars.add(match[1]);
    }
  }

  const missing = [...referencedVars].filter((name) => !documentedVars.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `Environment variables referenced in src/*.js but missing from .env.example: ${missing.join(', ')}`,
  );

  // Also ensure the PayPal, Coinbase Commerce, auto-withdraw, and tax-reporting
  // variables highlighted in #224 remain documented in .env.example.
  const requiredExtraVars = [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
    'PAYPAL_API_BASE',
    'COINBASE_COMMERCE_API_KEY',
    'COINBASE_COMMERCE_WEBHOOK_SECRET',
    'AUTO_WITHDRAW_MIN_THRESHOLD_STROOPS',
    'AUTO_WITHDRAW_SWEEP_INTERVAL_MS',
    'AUTO_WITHDRAW_PENDING_TTL_MS',
    'TAX_REPORTING_THRESHOLD_USD',
    'TAX_PAYER_NAME',
    'TAX_PAYER_TIN',
    'TAX_PAYER_ADDRESS',
  ];
  for (const name of requiredExtraVars) {
    assert.ok(documentedVars.has(name), `Expected ${name} to be documented in .env.example`);
  }
});
