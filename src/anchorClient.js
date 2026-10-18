import { StellarToml } from '@stellar/stellar-sdk';
import { withRetry } from './retry.js';
import { logger } from './logger.js';
import { config } from './config.js';

/**
 * Bounded on purpose: this is the one external call in the codebase that
 * previously relied on the Stellar SDK's global timeout default of 0
 * (unbounded), so a slow or hanging `ANCHOR_HOME_DOMAIN` could stall
 * `GET /anchor/config` indefinitely. A `.well-known/stellar.toml` fetch is
 * tiny, so a few seconds is plenty; the caching layer below means a
 * transient failure does not need to be low-latency-recovered, but a
 * retry matches the convention every other read-only chain-adjacent call
 * in this codebase already follows.
 */
const TOML_FETCH_TIMEOUT_MS = 5_000;
const TOML_FETCH_ATTEMPTS = 3;

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { value: null, expiresAt: 0 };

/**
 * Fetch and cache the anchor's stellar.toml. The resolve call is wrapped in
 * `withRetry` (which applies `withTimeout`) so a hanging third-party domain
 * rejects within the configured bound instead of hanging the request.
 */
export function isAnchorConfigured() {
  return Boolean(config.anchor.homeDomain);
}

export async function getAnchorConfig() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) {
    return cache.value;
  }

  const toml = await withRetry(
    () => StellarToml.Resolver.resolve(config.anchor.homeDomain),
    {
      attempts: TOML_FETCH_ATTEMPTS,
      timeoutMs: TOML_FETCH_TIMEOUT_MS,
      label: 'stellar.toml resolve',
    },
  );

  const value = {
    homeDomain: config.anchor.homeDomain,
    signingKey: toml?.SIGNING_KEY ?? null,
    webAuthEndpoint: toml?.WEB_AUTH_ENDPOINT ?? null,
    transferServer: toml?.TRANSFER_SERVER_SEP0024 ?? toml?.TRANSFER_SERVER ?? null,
  };

  cache = { value, expiresAt: now + CACHE_TTL_MS };
  logger.info({ homeDomain: config.anchor.homeDomain }, 'anchor config resolved');
  return value;
}

export function clearAnchorConfigCache() {
  cache = { value: null, expiresAt: 0 };
}
