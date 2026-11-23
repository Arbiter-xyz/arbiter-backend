import test from 'node:test';
import assert from 'node:assert/strict';
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import {
  u64Arg,
  i128Arg,
  addressArg,
  vecOfAddresses,
} from '../src/stellarClient.js';

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const SECOND_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

test('u64Arg round-trips 0 through scValToNative', () => {
  const scVal = u64Arg(0);
  assert.equal(scVal.switch().name, 'scvU64');
  assert.equal(scValToNative(scVal), 0n);
});

test('u64Arg round-trips 2^64-1 through scValToNative', () => {
  const max = 18446744073709551615n;
  const scVal = u64Arg(max);
  assert.equal(scVal.switch().name, 'scvU64');
  assert.equal(scValToNative(scVal), max);
});

test('i128Arg handles negative values', () => {
  const scVal = i128Arg(-42);
  assert.equal(scVal.switch().name, 'scvI128');
  assert.equal(scValToNative(scVal), -42n);
});

test('i128Arg round-trips a large negative value', () => {
  const value = -170141183460469231731687303715884105728n;
  const scVal = i128Arg(value);
  assert.equal(scVal.switch().name, 'scvI128');
  assert.equal(scValToNative(scVal), value);
});

test('addressArg encodes a valid address', () => {
  const scVal = addressArg(VALID_ADDRESS);
  assert.equal(scVal.switch().name, 'scvAddress');
  assert.equal(scValToNative(scVal), VALID_ADDRESS);
});

test('vecOfAddresses produces an scvVec of addresses', () => {
  const scVal = vecOfAddresses([VALID_ADDRESS, SECOND_ADDRESS]);
  assert.equal(scVal.switch().name, 'scvVec');

  const native = scValToNative(scVal);
  assert.deepEqual(native, [VALID_ADDRESS, SECOND_ADDRESS]);

  const inner = scVal.vec();
  assert.equal(inner.length, 2);
  for (const entry of inner) {
    assert.equal(entry.switch().name, 'scvAddress');
  }
});

test('vecOfAddresses throws on a non-address string', () => {
  assert.throws(() => vecOfAddresses(['not-an-address']));
});
