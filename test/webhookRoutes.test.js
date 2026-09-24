import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Transaction } from '@stellar/stellar-sdk';

// #55 — webhook registration API over real HTTP: auth, ownership, URL
// validation and the one-time secret reveal. Same spawned-server harness as
// server.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASSPHRASE = 'Test SDF Network ; September 2015';

function startServer(extraEnv) {
  const port = 4700 + Math.floor(Math.random() * 500);
  const child = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NETWORK_PASSPHRASE: PASSPHRASE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const fail = (err) => {
      child.kill();
      reject(err);
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('listening on')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => fail(new Error(`server exited early with code ${code}`)));
    setTimeout(() => fail(new Error('server did not start in time')), 10_000);
  });
  return { child, port, ready };
}

describe('webhook registration routes', () => {
  let server;
  let base;

  before(async () => {
    server = startServer({ PUSH_RATE_LIMIT_MAX: '100', WEBHOOKS_RATE_LIMIT_MAX: '100' });
    await server.ready;
    base = `http://localhost:${server.port}`;
  });

  after(() => server.child.kill());

  async function session(kp) {
    const { xdr } = await (await fetch(`${base}/payers/${kp.publicKey()}/session/challenge`, { method: 'POST' })).json();
    const tx = new Transaction(xdr, PASSPHRASE);
    tx.sign(kp);
    const res = await fetch(`${base}/payers/${kp.publicKey()}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    return (await res.json()).token;
  }

  const post = (body, headers = {}) =>
    fetch(`${base}/webhooks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  test('registering without any authentication is rejected with 401', async () => {
    const res = await post({ url: 'https://hooks.example.com/x' });
    assert.equal(res.status, 401);
  });

  test('an address with a session token for a DIFFERENT address is rejected with 401', async () => {
    const victim = Keypair.random();
    const attackerToken = await session(Keypair.random());
    const res = await post({ address: victim.publicKey(), token: attackerToken, url: 'https://hooks.example.com/x' });
    assert.equal(res.status, 401);
  });

  test('an unknown API key is rejected with 401', async () => {
    const res = await post({ url: 'https://hooks.example.com/x' }, { Authorization: `Bearer ak_live_${'0'.repeat(64)}` });
    assert.equal(res.status, 401);
  });

  test('register → list → delete round trip; the secret is only in the 201 response', async () => {
    const payer = Keypair.random();
    const token = await session(payer);
    const address = payer.publicKey();

    const created = await post({ address, token, url: 'https://hooks.example.com/arbiter', description: 'prod' });
    assert.equal(created.status, 201);
    const hook = await created.json();
    assert.match(hook.secret, /^whsec_[0-9a-f]{64}$/);
    assert.match(hook.note, /never shown again/);

    const listRes = await fetch(`${base}/webhooks?address=${address}&token=${encodeURIComponent(token)}`);
    assert.equal(listRes.status, 200);
    const listText = await listRes.text();
    assert.equal(listText.includes(hook.secret), false);
    const { webhooks } = JSON.parse(listText);
    assert.equal(webhooks.length, 1);
    assert.deepEqual(
      { id: webhooks[0].id, url: webhooks[0].url, description: webhooks[0].description, active: webhooks[0].active },
      { id: hook.id, url: 'https://hooks.example.com/arbiter', description: 'prod', active: true },
    );
    assert.equal('secret' in webhooks[0], false);

    const del = await fetch(`${base}/webhooks/${hook.id}?address=${address}&token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const after = await (await fetch(`${base}/webhooks?address=${address}&token=${encodeURIComponent(token)}`)).json();
    assert.deepEqual(after.webhooks, []);
  });

  test("a non-owner can't list or delete someone else's webhook (404, and it survives)", async () => {
    const owner = Keypair.random();
    const ownerToken = await session(owner);
    const other = Keypair.random();
    const otherToken = await session(other);

    const hook = await (await post({ address: owner.publicKey(), token: ownerToken, url: 'https://hooks.example.com/owned' })).json();

    const otherList = await (await fetch(`${base}/webhooks?address=${other.publicKey()}&token=${encodeURIComponent(otherToken)}`)).json();
    assert.deepEqual(otherList.webhooks, []);

    const del = await fetch(`${base}/webhooks/${hook.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: other.publicKey(), token: otherToken }),
    });
    assert.equal(del.status, 404);

    const ownerList = await (await fetch(`${base}/webhooks?address=${owner.publicKey()}&token=${encodeURIComponent(ownerToken)}`)).json();
    assert.equal(ownerList.webhooks.length, 1);
  });

  test('URL validation: non-https, localhost and private-network targets are rejected with 400', async () => {
    const payer = Keypair.random();
    const token = await session(payer);
    for (const url of ['http://hooks.example.com/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'not-a-url', '']) {
      const res = await post({ address: payer.publicKey(), token, url });
      assert.equal(res.status, 400, url);
    }
  });
});
