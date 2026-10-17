import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';

import {
  getAnchorConfig,
  validateAnchorToml,
  clearAnchorConfigCache,
} from '../src/anchorClient.js';

test.beforeEach(() => {
  clearAnchorConfigCache();
});

test('validateAnchorToml accepts valid Stellar SIGNING_KEY and HTTPS endpoints and rejects malformed shapes (#281)', () => {
  const validKey = Keypair.random().publicKey();
  const res = validateAnchorToml({
    SIGNING_KEY: validKey,
    WEB_AUTH_ENDPOINT: 'https://anchor.example.com/auth',
    TRANSFER_SERVER_SEP0024: 'https://anchor.example.com/sep24',
  });
  assert.deepEqual(res, {
    signingKey: validKey,
    webAuthEndpoint: 'https://anchor.example.com/auth',
    transferServer: 'https://anchor.example.com/sep24',
  });

  // Invalid SIGNING_KEY rejected
  assert.throws(
    () => validateAnchorToml({ SIGNING_KEY: 'not-a-stellar-key' }),
    /SIGNING_KEY must be a valid Stellar Ed25519 public key/,
  );

  // Non-HTTPS or credentialed endpoints rejected
  assert.throws(
    () => validateAnchorToml({ WEB_AUTH_ENDPOINT: 'http://anchor.example.com/auth' }),
    /WEB_AUTH_ENDPOINT must use https:/,
  );
  assert.throws(
    () => validateAnchorToml({ TRANSFER_SERVER: 'javascript:alert(1)' }),
    /TRANSFER_SERVER must use https:/,
  );
  assert.throws(
    () => validateAnchorToml({ TRANSFER_SERVER: 'https://user:pass@anchor.example.com/sep24' }),
    /must not contain credentials or fragments/,
  );
});

test('getAnchorConfig caches valid config, serves from cache within TTL, and refuses to cache invalid stellar.toml (#281)', async () => {
  const validKey = Keypair.random().publicKey();
  const cfg = { anchor: { homeDomain: 'anchor.example.com' } };

  await assert.rejects(
    () =>
      getAnchorConfig(cfg, {
        resolver: async () => ({
          SIGNING_KEY: 'malformed-key',
          WEB_AUTH_ENDPOINT: 'https://anchor.example.com/auth',
        }),
      }),
    /SIGNING_KEY/,
  );

  // Subsequent call with valid TOML succeeds because the invalid response was not cached
  let calls = 0;
  const resolver = async () => {
    calls += 1;
    return {
      SIGNING_KEY: validKey,
      WEB_AUTH_ENDPOINT: 'https://anchor.example.com/auth',
      TRANSFER_SERVER: 'https://anchor.example.com/sep6',
    };
  };

  const first = await getAnchorConfig(cfg, { resolver });
  const second = await getAnchorConfig(cfg, { resolver });
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.signingKey, validKey);
});
