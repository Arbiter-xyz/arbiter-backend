import test from 'node:test';
import assert from 'node:assert/strict';

import * as metered from '../src/metered.js';

// No network access: stub the on-chain balance reader before exercising
// getMeteredBalance so the test only covers the formatting logic.
const originalGetBalanceOnChain = metered.getBalanceOnChain;

test.after(() => {
  metered.getBalanceOnChain = originalGetBalanceOnChain;
});

test('depositInstructions returns structured fields clients can parse', () => {
  const instructions = metered.depositInstructions();

  assert.equal(typeof instructions, 'object');
  assert.ok(instructions !== null);

  // Contract id
  assert.equal(typeof instructions.contractId, 'string');
  assert.ok(instructions.contractId.length > 0);

  // Deposit / withdraw call shapes
  assert.equal(typeof instructions.deposit, 'object');
  assert.ok(instructions.deposit !== null);
  assert.equal(typeof instructions.deposit.fn, 'string');
  assert.ok(Array.isArray(instructions.deposit.args));

  assert.equal(typeof instructions.withdraw, 'object');
  assert.ok(instructions.withdraw !== null);
  assert.equal(typeof instructions.withdraw.fn, 'string');
  assert.ok(Array.isArray(instructions.withdraw.args));

  // Endpoints
  assert.equal(typeof instructions.sessionTokenEndpoint, 'string');
  assert.ok(instructions.sessionTokenEndpoint.length > 0);
  assert.equal(typeof instructions.askEndpoint, 'string');
  assert.ok(instructions.askEndpoint.length > 0);
});

test('getMeteredBalance formats stroops via stroopsToUsdc', async () => {
  const payerAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const stroops = 12_345_678n;

  metered.getBalanceOnChain = async (address) => {
    assert.equal(address, payerAddress);
    return stroops;
  };

  const result = await metered.getMeteredBalance(payerAddress);

  assert.equal(result.payerAddress, payerAddress);
  assert.equal(result.balanceStroops, stroops.toString());
  assert.equal(result.balance, metered.stroopsToUsdc(stroops));
});
