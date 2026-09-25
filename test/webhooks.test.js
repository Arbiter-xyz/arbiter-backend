import './helpers/webhook-registration-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWebhookUrl,
  isBlockedAddress,
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  deactivateWebhook,
  getDeliveryTargets,
  sealSecret,
  openSecret,
  setJobWebhookOwner,
  resolveJobOwner,
  WebhookError,
} from '../src/webhooks.js';
import { store } from '../src/store.js';

// #55 — webhook registration API storage + signed-secret handling.

const owner = (tag) => `payer:G${tag}${Date.now()}${Math.random().toString(36).slice(2)}`;

test('validateWebhookUrl accepts public https URLs and normalizes them', () => {
  assert.equal(validateWebhookUrl('https://hooks.example.com/arbiter'), 'https://hooks.example.com/arbiter');
  assert.equal(validateWebhookUrl('  https://EXAMPLE.com:8443/a?b=1 '), 'https://example.com:8443/a?b=1');
});

test('validateWebhookUrl rejects malformed, non-https and credentialed URLs', () => {
  for (const bad of [undefined, '', 'not a url', '/relative/path', 'ftp://example.com/x', 'http://example.com/hook',
    'https://user:pass@example.com/hook', 'https://example.com/hook#frag', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => validateWebhookUrl(bad), WebhookError, String(bad).slice(0, 40));
  }
});

test('validateWebhookUrl rejects SSRF-shaped targets: localhost names and private/reserved IP literals', () => {
  for (const bad of [
    'https://localhost/hook',
    'https://api.localhost/hook',
    'https://printer.local/hook',
    'https://metadata.google.internal/computeMetadata',
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://172.20.0.5/hook',
    'https://192.168.1.10/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ]) {
    assert.throws(() => validateWebhookUrl(bad), /publicly reachable|private, loopback or reserved/, bad);
  }
  assert.equal(validateWebhookUrl('https://93.184.216.34/hook'), 'https://93.184.216.34/hook');
});

test('isBlockedAddress covers IPv4, IPv6 and v4-mapped IPv6', () => {
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('registration returns the signing secret exactly once; listing never exposes it', async () => {
  const o = owner('A');
  const created = await registerWebhook(o, 'https://hooks.example.com/a', { description: 'prod' });
  assert.match(created.id, /^wh_[0-9a-f]{24}$/);
  assert.match(created.secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(created.active, true);
  assert.deepEqual(created.events, ['question.settled']);

  const [listed] = await listWebhooks(o);
  assert.equal(listed.id, created.id);
  assert.equal(listed.description, 'prod');
  assert.equal('secret' in listed, false);
  assert.equal(JSON.stringify(await listWebhooks(o)).includes(created.secret), false);
});

test('the stored secret is encrypted at rest but recoverable for signing', async () => {
  const o = owner('B');
  const created = await registerWebhook(o, 'https://hooks.example.com/b');
  const raw = await store.get(`webhook:${created.id}`);
  assert.match(raw.secret, /^gcm:/);
  assert.equal(raw.secret.includes(created.secret.slice(6)), false);

  const [target] = await getDeliveryTargets(o);
  assert.deepEqual(target, { id: created.id, url: 'https://hooks.example.com/b', secret: created.secret });
});

test('sealed secrets detect tampering', () => {
  const sealed = sealSecret('whsec_abc');
  assert.equal(openSecret(sealed), 'whsec_abc');
  const [iv, tag, ct] = sealed.slice(4).split('.');
  const flipped = Buffer.from(ct, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => openSecret(`gcm:${iv}.${tag}.${flipped.toString('base64url')}`));
});

test('owners only ever see and delete their own registrations', async () => {
  const alice = owner('C');
  const mallory = owner('D');
  const hook = await registerWebhook(alice, 'https://hooks.example.com/c');

  assert.deepEqual(await listWebhooks(mallory), []);
  assert.equal(await deleteWebhook(mallory, hook.id), false); // non-owner: rejected
  assert.equal((await listWebhooks(alice)).length, 1); // ...and nothing was removed

  assert.equal(await deleteWebhook(alice, hook.id), true);
  assert.deepEqual(await listWebhooks(alice), []);
  assert.equal(await store.get(`webhook:${hook.id}`), null);
  assert.equal(await deleteWebhook(alice, hook.id), false); // already gone
});

test('duplicate URLs and the per-owner cap are rejected with 409', async () => {
  const o = owner('E');
  await registerWebhook(o, 'https://hooks.example.com/1');
  await assert.rejects(registerWebhook(o, 'https://hooks.example.com/1'), (e) => e.status === 409);
  await registerWebhook(o, 'https://hooks.example.com/2');
  await registerWebhook(o, 'https://hooks.example.com/3');
  await assert.rejects(registerWebhook(o, 'https://hooks.example.com/4'), (e) => e.status === 409 && /at most 3/.test(e.message));
});

test('registration without an owner is rejected with 401', async () => {
  await assert.rejects(registerWebhook(null, 'https://hooks.example.com/x'), (e) => e.status === 401);
});

test('deactivated registrations stay listed (with the reason) but stop receiving deliveries', async () => {
  const o = owner('F');
  const hook = await registerWebhook(o, 'https://hooks.example.com/f');
  await deactivateWebhook(hook.id, 'receiver answered 410 Gone');
  const [listed] = await listWebhooks(o);
  assert.equal(listed.active, false);
  assert.equal(listed.deactivatedReason, 'receiver answered 410 Gone');
  assert.deepEqual(await getDeliveryTargets(o), []);
});

test('registrations are durable records (no TTL), unlike job records', async () => {
  const o = owner('G');
  const hook = await registerWebhook(o, 'https://hooks.example.com/g');
  // MemoryStore keeps {value, expiresAt}; durability == expiresAt null. With
  // REDIS_URL set, the same record is written without PX (see RedisStore.set).
  const entry = store.map?.get(`webhook:${hook.id}`);
  if (entry) assert.equal(entry.expiresAt, null);
});

test('job owner resolution: an explicit API-key owner wins over job.payer (the fiat pool), else the payer', async () => {
  const jobId = `job-${Date.now()}`;
  assert.equal(await resolveJobOwner(jobId, { payer: 'GPAYERADDR' }), 'payer:GPAYERADDR');
  assert.equal(await resolveJobOwner(jobId, { payer: null }), null);
  await setJobWebhookOwner(jobId, 'account:acct_123');
  assert.equal(await resolveJobOwner(jobId, { payer: 'GPOOL' }), 'account:acct_123');
});
