import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  TaxReportError,
  parseTaxYear,
  stroopsToUsd,
  saveTaxProfile,
  getTaxProfile,
} from '../src/taxReport.js';

test('stroopsToUsd rounds half-up at the exact .005 cent boundary (50,000 stroops) (#276)', () => {
  assert.equal(stroopsToUsd(0n), '0.00');
  assert.equal(stroopsToUsd(49_999n), '0.00', 'just below 0.5 cent rounds down');
  assert.equal(stroopsToUsd(50_000n), '0.01', 'exact 0.5 cent (.005 USD) rounds half-up to 0.01');
  assert.equal(stroopsToUsd(50_001n), '0.01');
  assert.equal(stroopsToUsd(100_000n), '0.01');
  assert.equal(stroopsToUsd(149_999n), '0.01');
  assert.equal(stroopsToUsd(150_000n), '0.02', 'exact 1.5 cents (.015 USD) rounds half-up to 0.02');
  assert.equal(stroopsToUsd(10_000_000n), '1.00');
  assert.equal(stroopsToUsd(10_049_999n), '1.00');
  assert.equal(stroopsToUsd(10_050_000n), '1.01', 'exact $1.005 rounds half-up to 1.01');
  assert.equal(stroopsToUsd(6_000_000_000n), '600.00', 'IRS 1099-NEC $600 threshold');
  assert.throws(() => stroopsToUsd(-1n), TaxReportError);
});

test('parseTaxYear defaults to previous UTC year and validates bounds', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  assert.equal(parseTaxYear(undefined, now), 2025);
  assert.equal(parseTaxYear('', now), 2025);
  assert.equal(parseTaxYear('2024', now), 2024);
  assert.equal(parseTaxYear(2020, now), 2020);
  assert.throws(() => parseTaxYear(2019, now), TaxReportError);
  assert.throws(() => parseTaxYear(2027, now), TaxReportError);
});

test('saveTaxProfile stores only last 4 TIN digits and validates US address fields', async () => {
  const worker = Keypair.random().publicKey();
  const saved = await saveTaxProfile(worker, {
    usPerson: true,
    legalName: 'Alice Example',
    tinType: 'SSN',
    tin: '123-45-6789',
    mailingAddress: {
      line1: '100 Main St',
      city: 'Austin',
      state: 'tx',
      postalCode: '78701',
    },
  });
  assert.equal(saved.tinLast4, '6789');
  assert.equal(saved.mailingAddress.state, 'TX');
  assert.equal(saved.mailingAddress.country, 'US');
  const loaded = await getTaxProfile(worker);
  assert.equal(loaded.tinLast4, '6789');
});
