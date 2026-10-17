import { StellarToml, StrKey } from '@stellar/stellar-sdk';
import { withRetry } from './retry.js';
import { logger } from './logger.js';

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

function validateHttpsEndpoint(fieldName, raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Invalid anchor stellar.toml: ${fieldName} must be a non-empty URL string`);
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid anchor stellar.toml: ${fieldName} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Invalid anchor stellar.toml: ${fieldName} must use https:`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Invalid anchor stellar.toml: ${fieldName} must not contain credentials or fragments`);
  }
  return parsed.toString();
}

export function validateAnchorToml(toml) {
  if (!toml || typeof toml !== 'object' || Array.isArray(toml)) {
    throw new Error('Invalid anchor stellar.toml: expected a top-level TOML object');
  }

  let signingKey = null;
  if (toml.SIGNING_KEY !== undefined && toml.SIGNING_KEY !== null) {
    if (typeof toml.SIGNING_KEY !== 'string' || !StrKey.isValidEd25519PublicKey(toml.SIGNING_KEY)) {
      throw new Error('Invalid anchor stellar.toml: SIGNING_KEY must be a valid Stellar Ed25519 public key');
    }
    signingKey = toml.SIGNING_KEY;
  }

  const webAuthEndpoint = validateHttpsEndpoint('WEB_AUTH_ENDPOINT', toml.WEB_AUTH_ENDPOINT);
  const rawTransfer = toml.TRANSFER_SERVER_SEP0024 ?? toml.TRANSFER_SERVER ?? null;
  const transferServer = validateHttpsEndpoint('TRANSFER_SERVER', rawTransfer);

  return { signingKey, webAuthEndpoint, transferServer };
}

/**
 * Fetch, validate, and cache the anchor's stellar.toml. The resolve call is
 * wrapped in `withRetry` (which applies `withTimeout`) so a hanging
 * third-party domain rejects within the configured bound instead of hanging
 * the request, and `validateAnchorToml` ensures malformed or non-HTTPS fields
 * are never cached (#281).
 */
export async function getAnchorConfig(
  config,
  { resolver = (domain) => StellarToml.Resolver.resolve(domain) } = {},
) {
  const homeDomain = config?.anchor?.homeDomain;
  if (!homeDomain || typeof homeDomain !== 'string') {
    throw new Error('anchor.homeDomain is required');
  }

  const now = Date.now();
  if (cache.value && cache.value.homeDomain === homeDomain && cache.expiresAt > now) {
    return cache.value;
  }

  const toml = await withRetry(() => resolver(homeDomain), {
    attempts: TOML_FETCH_ATTEMPTS,
    timeoutMs: TOML_FETCH_TIMEOUT_MS,
    label: 'stellar.toml resolve',
  });

  const validated = validateAnchorToml(toml);
  const value = {
    homeDomain,
    ...validated,
  };

  cache = { value, expiresAt: now + CACHE_TTL_MS };
  logger.info({ homeDomain }, 'anchor config resolved');
  return value;
}

export function clearAnchorConfigCache() {
  cache = { value: null, expiresAt: 0 };
}
