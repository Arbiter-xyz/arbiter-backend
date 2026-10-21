import { StellarToml, StrKey } from '@stellar/stellar-sdk';
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
 * Validate a value from the anchor's stellar.toml before it is trusted and
 * cached. The TOML is fetched from a third-party domain, so a malformed or
 * malicious response must not be able to inject arbitrary values downstream.
 * Returns the trimmed string when it is a non-empty string, otherwise null.
 */
function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate a Stellar account ID (SIGNING_KEY). Returns the value only when it
 * is a well-formed ed25519 public key, otherwise null.
 */
function asSigningKey(value) {
  const str = asNonEmptyString(value);
  if (!str) return null;
  try {
    return StrKey.isValidEd25519PublicKey(str) ? str : null;
  } catch {
    return null;
  }
}

/**
 * Validate an endpoint URL (WEB_AUTH_ENDPOINT / TRANSFER_SERVER). Returns the
 * value only when it parses as an http(s) URL, otherwise null.
 */
function asEndpointUrl(value) {
  const str = asNonEmptyString(value);
  if (!str) return null;
  try {
    const url = new URL(str);
    return url.protocol === 'https:' || url.protocol === 'http:' ? str : null;
  } catch {
    return null;
  }
}

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
    signingKey: asSigningKey(toml?.SIGNING_KEY),
    webAuthEndpoint: asEndpointUrl(toml?.WEB_AUTH_ENDPOINT),
    transferServer: asEndpointUrl(toml?.TRANSFER_SERVER_SEP0024 ?? toml?.TRANSFER_SERVER),
  };

  cache = { value, expiresAt: now + CACHE_TTL_MS };
  logger.info({ homeDomain: config.anchor.homeDomain }, 'anchor config resolved');
  return value;
}

/**
 * Derive whether the anchor is configured from the resolved config value,
 * matching the same shape `getAnchorConfig()` returns. Kept in sync with the
 * cache so callers get a cheap synchronous check without re-fetching.
 */
export function isAnchorConfigured(config) {
  const value = cache.value;
  if (!value) {
    return Boolean(config?.anchor?.homeDomain);
  }
  return Boolean(value.homeDomain && value.signingKey);
}

export function clearAnchorConfigCache() {
  cache = { value: null, expiresAt: 0 };
}
