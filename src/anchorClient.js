import { StellarToml } from '@stellar/stellar-sdk';
import { config } from './config.js';

/**
 * Arbiter is a CLIENT of the configured anchor's stellar.toml — never a
 * money transmitter itself. This module's only job is resolving and
 * caching that public config so the frontend doesn't need to CORS-fetch
 * an arbitrary third-party domain's .well-known/stellar.toml directly
 * (some anchors don't set permissive CORS on that file, even though they
 * do on the SEP-10/24/12 endpoints themselves, which exist specifically
 * to be called from a browser).
 *
 * Deliberately does NOT proxy SEP-10 challenge/sign, SEP-24 interactive
 * deposit/withdraw, or SEP-12 customer status: those are all gated by a
 * JWT that only the account holder can obtain (by signing the SEP-10
 * challenge themselves), so this backend has no authority to fetch them
 * on a user's behalf. The frontend calls those endpoints directly against
 * the anchor using the config this module resolves — see app/src/anchor.js.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { config, expiresAt }

export function isAnchorConfigured() {
  return Boolean(config.anchor.homeDomain);
}

export async function getAnchorConfig() {
  if (!isAnchorConfigured()) return null;
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const toml = await StellarToml.Resolver.resolve(config.anchor.homeDomain);
  const resolved = {
    homeDomain: config.anchor.homeDomain,
    signingKey: toml.SIGNING_KEY || null,
    webAuthEndpoint: toml.WEB_AUTH_ENDPOINT || null,
    transferServerSep24: toml.TRANSFER_SERVER_SEP0024 || null,
    kycServer: toml.KYC_SERVER || null,
    quoteServer: toml.ANCHOR_QUOTE_SERVER || null,
  };

  cached = { config: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}
