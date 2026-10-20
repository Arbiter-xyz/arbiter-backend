'use strict';

const assert = require('assert');
const { backoffDelayMs } = require('../src/webhookDelivery');

// Issue #328: the 20% random jitter on exponential backoff was not asserted
// to stay within bounds across many random() draws. These tests pin the
// documented behavior so future audits can treat the area as reviewed.

describe('backoffDelayMs jitter bounds', () => {
  const BASE = 1000;
  const MAX_ATTEMPTS = 10;

  it('stays within +/-20% of the exponential base across many draws', () => {
    const originalRandom = Math.random;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const base = BASE * Math.pow(2, attempt);
        const lower = base * 0.8;
        const upper = base * 1.2;

        for (let i = 0; i < 1000; i++) {
          const delay = backoffDelayMs(attempt, BASE);
          assert.ok(
            delay >= lower && delay <= upper,
            `attempt ${attempt}: delay ${delay} outside [${lower}, ${upper}]`
          );
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  });

  it('respects the jitter bounds at the random() extremes', () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      assert.strictEqual(backoffDelayMs(0, BASE), BASE * 0.8);

      Math.random = () => 1;
      assert.strictEqual(backoffDelayMs(0, BASE), BASE * 1.2);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('grows exponentially with the attempt number', () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.5;
      const first = backoffDelayMs(0, BASE);
      const second = backoffDelayMs(1, BASE);
      const third = backoffDelayMs(2, BASE);

      assert.strictEqual(first, BASE);
      assert.strictEqual(second, BASE * 2);
      assert.strictEqual(third, BASE * 4);
    } finally {
      Math.random = originalRandom;
    }
  });
});

// Issue #338: isBlockedAddress unwraps IPv4-mapped IPv6 addresses
// (::ffff:a.b.c.d) and must enforce the same blocked IPv4 subnets on the
// unwrapped address, not only the plain IPv6 ranges. These tests pin that
// behavior so the mapped-address path is covered for future audits.
describe('isBlockedAddress IPv4-mapped IPv6 coverage', () => {
  const { isBlockedAddress } = require('../src/webhooks');

  it('blocks IPv4-mapped IPv6 forms of blocked IPv4 subnets', () => {
    const blocked = [
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:192.168.1.1',
      '::ffff:169.254.169.254',
    ];
    for (const addr of blocked) {
      assert.strictEqual(
        isBlockedAddress(addr),
        true,
        `expected ${addr} to be blocked via mapped-address unwrap`
      );
    }
  });

  it('allows IPv4-mapped IPv6 forms of public IPv4 addresses', () => {
    const allowed = ['::ffff:8.8.8.8', '::ffff:1.1.1.1'];
    for (const addr of allowed) {
      assert.strictEqual(
        isBlockedAddress(addr),
        false,
        `expected ${addr} to be allowed`
      );
    }
  });
});
