import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  deriveIpHmacKey,
  hashIp,
  pairKey,
  pairObservations,
  scorePair,
  recordWorkerIp,
  evaluatePair,
} from '../src/collusion.js';
import { config } from '../src/config.js';

test('deriveIpHmacKey and hashIp separate IP HMAC key material from raw session secret (#278)', () => {
  const ip = '203.0.113.42';
  const rawSessionHmac = createHmac('sha256', config.session.secret)
    .update(`ip:${ip}`)
    .digest('hex')
    .slice(0, 32);

  const hashed = hashIp(ip);
  assert.equal(hashed.length, 32);
  assert.match(hashed, /^[0-9a-f]{32}$/);
  assert.notEqual(
    hashed,
    rawSessionHmac,
    'hashIp must use a domain-separated subkey rather than the raw session-signing key',
  );
  assert.equal(hashIp(ip, 'secret-a'), hashIp(ip, 'secret-a'));
  assert.notEqual(hashIp(ip, 'secret-a'), hashIp(ip, 'secret-b'));
  assert.notEqual(deriveIpHmacKey('secret-a').toString('hex'), Buffer.from('secret-a').toString('hex'));
});

test('pairObservations and scorePair detect coordinated wrong answers and shared IPs', async () => {
  const w1 = `w1-${Date.now()}`;
  const w2 = `w2-${Date.now()}`;
  await recordWorkerIp(w1, '198.51.100.10');
  await recordWorkerIp(w2, '198.51.100.10');

  const obs = pairObservations(
    [
      { workerId: w1, answer: 'wrong answer' },
      { workerId: w2, answer: 'Wrong Answer' },
    ],
    ['w3'],
    { [w1]: 1000, [w2]: 1500 },
    5000,
  );
  assert.equal(obs.length, 1);
  assert.equal(obs[0].key, pairKey(w1, w2));
  assert.deepEqual(obs[0].deltas, { shared: 1, sameAnswer: 1, sameWrong: 1, synced: 1 });

  const scored = scorePair(
    {
      counters: { shared: 6, sameAnswer: 6, sameWrong: 3, synced: 6 },
      ratioA: 0.5,
      ratioB: 0.5,
      referral: true,
      sharedIp: true,
    },
    5,
  );
  assert.ok(scored.score > 0.8);
  assert.equal(scored.signals.sharedIp, 1);

  const evalResult = await evaluatePair(w1, w2, async () => ({ total: 10, matched: 8 }));
  assert.equal(evalResult.signals.sharedIp, 1);
});
