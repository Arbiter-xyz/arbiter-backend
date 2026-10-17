import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WebhookError,
  isBlockedAddress,
  validateWebhookUrl,
  sealSecret,
  openSecret,
  resetPlaintextSecretWarningForTests,
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  deactivateWebhook,
  getDeliveryTargets,
} from '../src/webhooks.js';
import { store } from '../src/store.js';

test('isBlockedAddress and validateWebhookUrl block IPv4-mapped IPv6 in both dotted-quad and hex-hextet forms (#338)', () => {
  // Dotted-quad IPv4-mapped IPv6
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedAddress('::ffff:192.168.1.1'), true);
  assert.equal(isBlockedAddress('::ffff:100.64.0.1'), true);

  // Canonical hex-hextet IPv4-mapped IPv6 (produced by WHATWG new URL('https://[::ffff:127.0.0.1]'))
  assert.equal(isBlockedAddress('::ffff:7f00:1'), true);
  assert.equal(isBlockedAddress('::ffff:a00:1'), true);
  assert.equal(isBlockedAddress('::ffff:a9fe:a9fe'), true);
  assert.equal(isBlockedAddress('::ffff:c0a8:101'), true);
  assert.equal(isBlockedAddress('0:0:0:0:0:ffff:7f00:1'), true);

  // Public addresses are allowed
  assert.equal(isBlockedAddress('::ffff:93.184.216.34'), false);
  assert.equal(isBlockedAddress('::ffff:5db8:d822'), false);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);

  // validateWebhookUrl rejects bracketed IPv4-mapped loopback/metadata URLs
  assert.throws(
    () => validateWebhookUrl('https://[::ffff:127.0.0.1]/webhook', { allowInsecure: false }),
    (err) => err instanceof WebhookError && /private, loopback or reserved/i.test(err.message),
  );
  assert.throws(
    () => validateWebhookUrl('https://[::ffff:169.254.169.254]/latest/meta-data', { allowInsecure: false }),
    (err) => err instanceof WebhookError && /private, loopback or reserved/i.test(err.message),
  );
  assert.equal(
    validateWebhookUrl('https://[::ffff:93.184.216.34]/webhook', { allowInsecure: false }),
    'https://[::ffff:5db8:d822]/webhook',
  );
});

test('sealSecret and openSecret support AES-256-GCM encryption and warn once on plaintext fallback (#279)', () => {
  resetPlaintextSecretWarningForTests();
  const raw = sealSecret('whsec_plain', { secretKey: '' });
  assert.equal(raw, 'raw:whsec_plain');
  assert.equal(openSecret(raw, { secretKey: '' }), 'whsec_plain');

  const encrypted = sealSecret('whsec_secret_123', { secretKey: 'master-test-key' });
  assert.equal(encrypted.startsWith('gcm:'), true);
  assert.equal(openSecret(encrypted, { secretKey: 'master-test-key' }), 'whsec_secret_123');

  assert.throws(
    () => openSecret(encrypted, { secretKey: 'wrong-key' }),
    /unable to authenticate|Unsupported state/i,
  );
});

test('registerWebhook prunes stale owner index entries while preserving valid registrations (#277)', async () => {
  const owner = `account:acct_${Date.now()}`;
  await store.set(`webhooks-by-owner:${owner}`, ['wh_stale_ghost_id']);

  const reg1 = await registerWebhook(owner, 'https://example.com/hook-1', {
    description: 'Primary hook',
  });
  const reg2 = await registerWebhook(owner, 'https://example.com/hook-2', {
    description: 'Secondary hook',
  });

  const ownerList = await store.get(`webhooks-by-owner:${owner}`);
  assert.equal(ownerList.includes('wh_stale_ghost_id'), false);
  assert.deepEqual(ownerList, [reg2.id, reg1.id]);

  const listed = await listWebhooks(owner);
  assert.equal(listed.length, 2);
  assert.equal('secret' in listed[0], false);

  await deactivateWebhook(reg1.id, '410 Gone');
  const activeTargets = await getDeliveryTargets(owner);
  assert.equal(activeTargets.length, 1);
  assert.equal(activeTargets[0].id, reg2.id);
  assert.equal(activeTargets[0].secret, reg2.secret);

  assert.equal(await deleteWebhook(owner, reg2.id), true);
  assert.equal(await deleteWebhook('account:other', reg1.id), false);
});
