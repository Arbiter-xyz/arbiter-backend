import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { store } from './store.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Webhook registrations: an owner tells Arbiter where to POST when one of
 * their questions settles, instead of polling GET /oracle/:jobId. Delivery
 * and signing live in webhookDelivery.js; this module owns who may
 * register what, and how it's stored.
 *
 * Owners are one of two identities this backend already authenticates. It
 * has no account system of its own:
 *   - `payer:<G...address>`: a wallet payer that proved control of the
 *     address via the workerAuth.js session flow (verifySessionToken).
 *   - `account:<acct_...>`: a billing.js API-key customer (resolveApiKey).
 *
 * Storage follows the same durable (no TTL), bounded, index-backed pattern
 * as dispatch.js's WORKER_INDEX_KEY and payerIndex.js's PAYER_INDEX_KEY:
 *   webhook:<id>                 the registration record
 *   webhooks-by-owner:<owner>    that owner's registration ids
 *   known-webhook-ids            every registration id, for ops tooling
 *
 * The per-registration signing secret is generated here, returned once from
 * registerWebhook(), and never exposed by any read path afterwards. That's
 * the same one-time-reveal convention as billing.js's API keys, and as
 * Stripe's webhook signing secrets.
 */

const REG_PREFIX = 'webhook:';
const OWNER_PREFIX = 'webhooks-by-owner:';
const JOB_OWNER_PREFIX = 'job-webhook-owner:';
const WEBHOOK_INDEX_KEY = 'known-webhook-ids';
const MAX_TRACKED_WEBHOOKS = 5_000;
const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 200;

export class WebhookError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ── URL validation ───────────────────────────────────────────────────────
//
// Validation stance: unlike billing.js's isAllowedRedirectUrl(), a webhook
// target is by definition an external URL the owner controls, so there is
// no allowlist. What must never happen is the backend being tricked into
// POSTing at its OWN network (cloud metadata endpoints, Redis, admin
// sidecars): that's the SSRF risk. So:
//   - https only, no embedded credentials, bounded length;
//   - hostnames like localhost/*.local/*.internal and IP literals in
//     loopback, private, link-local, CGNAT, multicast or reserved ranges are
//     rejected at registration;
//   - the same range check runs again at DELIVERY time against the address
//     the hostname actually resolves to (webhookDelivery.js pins the checked
//     address for the connection). That defeats DNS rebinding, where a name
//     resolves publicly at registration and privately later.
// WEBHOOK_ALLOW_INSECURE_TARGETS=true lifts all of this for local
// development and tests only.

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
]) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/**
 * Parses a valid IPv6 address into 8 16-bit hextets and returns the embedded
 * dotted-quad IPv4 string if the address is IPv4-mapped (`::ffff:0:0/96`),
 * SIIT IPv4-translated (`::ffff:0:0:0/96`), or IPv4-compatible (`::/96`),
 * covering both dotted-quad (`::ffff:127.0.0.1`) and WHATWG URL canonical
 * hex-hextet (`::ffff:7f00:1`) representations (#338).
 */
function extractEmbeddedIpv4(ipv6) {
  let normalized = ipv6.toLowerCase();
  const zoneIdx = normalized.indexOf('%');
  if (zoneIdx !== -1) normalized = normalized.slice(0, zoneIdx);

  // Convert trailing dotted-quad (e.g. ::ffff:127.0.0.1) into two hex hextets.
  const dottedMatch = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (dottedMatch) {
    const octets = dottedMatch.slice(2, 6).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${dottedMatch[1]}${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const words = [...left, ...Array(missing).fill('0'), ...right].map((w) => parseInt(w, 16));
  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;

  const isMapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;
  const isTranslated =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0xffff &&
    words[5] === 0;
  const isCompatible =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0 &&
    (words[6] !== 0 || words[7] > 1);

  if (!isMapped && !isTranslated && !isCompatible) return null;
  const hi = words[6];
  const lo = words[7];
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** True for any address a webhook must never be delivered to. */
export function isBlockedAddress(address) {
  if (typeof address !== 'string') return true;
  const clean = address.replace(/^\[|\]$/g, '');
  const family = isIP(clean);
  if (family === 0) return true;
  if (family === 6) {
    const embeddedV4 = extractEmbeddedIpv4(clean);
    if (embeddedV4) return blocked.check(embeddedV4, 'ipv4');
    return blocked.check(clean, 'ipv6');
  }
  return blocked.check(clean, 'ipv4');
}

/** Returns the normalized URL string, or throws WebhookError. */
export function validateWebhookUrl(raw, { allowInsecure = config.webhooks?.allowInsecureTargets } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new WebhookError('url (string) is required');
  if (raw.length > MAX_URL_LENGTH) throw new WebhookError(`url must be at most ${MAX_URL_LENGTH} characters`);

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebhookError('url must be an absolute URL');
  }
  const schemes = allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!schemes.includes(url.protocol)) throw new WebhookError('url must use https');
  if (url.username || url.password) throw new WebhookError('url must not contain credentials');
  if (url.hash) throw new WebhookError('url must not contain a #fragment');

  if (!allowInsecure) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) {
      throw new WebhookError('url must point at a publicly reachable host');
    }
    if (isIP(host) && isBlockedAddress(host)) {
      throw new WebhookError('url must not target a private, loopback or reserved address');
    }
  }
  return url.toString();
}

// ── Secret storage ───────────────────────────────────────────────────────

let warnedPlaintextSecret = false;

export function resetPlaintextSecretWarningForTests() {
  warnedPlaintextSecret = false;
}

function encryptionKey(overrideKey) {
  const k = overrideKey !== undefined ? overrideKey : config.webhooks?.secretEncryptionKey;
  return k ? createHash('sha256').update(k).digest() : null;
}

/** Encrypts a signing secret for storage when WEBHOOK_SECRET_ENCRYPTION_KEY
 * is set (AES-256-GCM, so tampering is detected on read). Logs a warning
 * when falling back to plaintext storage (#279). */
export function sealSecret(secret, { secretKey } = {}) {
  const key = encryptionKey(secretKey);
  if (!key) {
    if (!warnedPlaintextSecret) {
      warnedPlaintextSecret = true;
      logger.warn(
        'WEBHOOK_SECRET_ENCRYPTION_KEY is not set — storing webhook signing secret in plaintext (raw: prefix)',
      );
    }
    return `raw:${secret}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `gcm:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function openSecret(sealed, { secretKey } = {}) {
  if (sealed.startsWith('raw:')) return sealed.slice(4);
  const key = encryptionKey(secretKey);
  if (!key) throw new Error('webhook secret is encrypted but WEBHOOK_SECRET_ENCRYPTION_KEY is not set');
  const [iv, tag, ct] = sealed.slice(4).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Registrations ────────────────────────────────────────────────────────

function publicView(record, delivery) {
  return {
    id: record.id,
    url: record.url,
    description: record.description,
    events: record.events,
    active: record.active,
    createdAt: record.createdAt,
    ...(record.deactivatedReason ? { deactivatedReason: record.deactivatedReason } : {}),
    lastDelivery: delivery || null,
  };
}

async function ownerIds(owner) {
  return (await store.get(OWNER_PREFIX + owner)) || [];
}

/**
 * Creates a registration and returns it WITH its signing secret. This is
 * the only time the secret is ever returned.
 */
export async function registerWebhook(owner, rawUrl, { description } = {}) {
  if (!owner) throw new WebhookError('unauthenticated', 401);
  const url = validateWebhookUrl(rawUrl);
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new WebhookError(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  const ids = await ownerIds(owner);
  const recordsAtRead = await Promise.all(ids.map((id) => store.get(REG_PREFIX + id)));
  const missingIds = new Set(ids.filter((_, idx) => !recordsAtRead[idx]));
  const existing = recordsAtRead.filter(Boolean);
  const maxPerOwner = config.webhooks?.maxPerOwner ?? 10;
  if (existing.length >= maxPerOwner) {
    throw new WebhookError(`at most ${maxPerOwner} webhooks per owner — delete one first`, 409);
  }
  if (existing.some((r) => r.url === url)) {
    throw new WebhookError('a webhook for this url is already registered', 409);
  }

  const id = `wh_${randomBytes(12).toString('hex')}`;
  const secret = `whsec_${randomBytes(32).toString('hex')}`;
  const record = {
    id,
    owner,
    url,
    description: description || null,
    events: ['question.settled'], // the only event type in v1
    active: true,
    createdAt: Date.now(),
    secret: sealSecret(secret),
  };

  // No TTL: registrations are identity/config records and must survive
  // restarts, like every other such record in this codebase.
  await store.set(REG_PREFIX + id, record);
  // Re-read the owner's index before writing so a concurrent registration
  // completed between the initial read and now is preserved, while still
  // pruning only IDs confirmed missing at read time (#277).
  const latestIds = await ownerIds(owner);
  const mergedOwnerIds = [
    id,
    ...latestIds.filter((x) => x !== id && !missingIds.has(x)),
  ];
  await store.set(OWNER_PREFIX + owner, mergedOwnerIds);
  const known = (await store.get(WEBHOOK_INDEX_KEY)) || [];
  await store.set(WEBHOOK_INDEX_KEY, [id, ...known].slice(0, MAX_TRACKED_WEBHOOKS));

  return { ...publicView(record, null), secret };
}

/** An owner's registrations, newest first, without secrets. */
export async function listWebhooks(owner) {
  const ids = await ownerIds(owner);
  const records = await Promise.all(ids.map((id) => store.get(REG_PREFIX + id)));
  const deliveries = await Promise.all(ids.map((id) => store.get(`webhook-delivery:${id}`)));
  return records
    .map((r, i) => (r && r.owner === owner ? publicView(r, deliveries[i]) : null))
    .filter(Boolean);
}

/** Deletes a registration. Returns false when it doesn't exist OR belongs
 * to someone else: the caller answers 404 either way, so ids can't be
 * probed across owners. */
export async function deleteWebhook(owner, id) {
  const record = await store.get(REG_PREFIX + id);
  if (!record || record.owner !== owner) return false;

  await store.delete(REG_PREFIX + id);
  await store.delete(`webhook-delivery:${id}`);
  await store.set(OWNER_PREFIX + owner, (await ownerIds(owner)).filter((x) => x !== id));
  const known = (await store.get(WEBHOOK_INDEX_KEY)) || [];
  await store.set(WEBHOOK_INDEX_KEY, known.filter((x) => x !== id));
  return true;
}

/** Stops deliveries to a registration without deleting it, e.g. when the
 * receiver answers 410 Gone. The owner still sees it (and why) in
 * listWebhooks(). */
export async function deactivateWebhook(id, reason) {
  const record = await store.get(REG_PREFIX + id);
  if (!record) return;
  await store.set(REG_PREFIX + id, { ...record, active: false, deactivatedReason: reason });
}

/** Internal: active registrations for an owner WITH decrypted secrets, for
 * webhookDelivery.js only. Never returned over HTTP. */
export async function getDeliveryTargets(owner) {
  if (!owner) return [];
  const ids = await ownerIds(owner);
  const records = await Promise.all(ids.map((id) => store.get(REG_PREFIX + id)));
  return records
    .filter((r) => r && r.active && r.owner === owner)
    .map((r) => ({ id: r.id, url: r.url, secret: openSecret(r.secret) }));
}

// ── Job ownership ────────────────────────────────────────────────────────

/** API-key jobs are paid from the shared fiat pool, so `job.payer` names the
 * pool, not the customer. The customer's account id is recorded here (not
 * on the job record, which GET /oracle/:jobId serves to anyone holding the
 * job id) so their settlement webhooks can be found. */
export async function setJobWebhookOwner(jobId, owner) {
  await store.set(JOB_OWNER_PREFIX + jobId, owner, config.jobResultTtlMs);
}

export async function resolveJobOwner(jobId, job) {
  const explicit = await store.get(JOB_OWNER_PREFIX + jobId);
  if (explicit) return explicit;
  const payer = job?.payer;
  if (payer && payer !== config.billing.fiatPoolAddress) return `payer:${payer}`;
  return null; // sandbox and other ownerless jobs
}
