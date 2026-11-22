import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (time-based one-time password), implemented from scratch on
 * Node's built-in crypto — no otplib/speakeasy dependency needed for the
 * standard 6-digit/30-second/HMAC-SHA1 case every authenticator app (Google
 * Authenticator, Authy, 1Password, etc.) already implements.
 *
 * This backs admin 2FA (#130): an operator's shared ADMIN_TOTP_SECRET is
 * provisioned into their authenticator app once, and every /admin/* request
 * must then present the current 6-digit code via the X-Admin-TOTP header
 * (see adminAuth.js's requireAdminRole). logger.js already redacts that
 * header from logs/session recordings so a leaked log line can't replay it.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
// Accept the previous/current/next 30s step, so verification tolerates
// ordinary clock drift between this server and the operator's phone.
const WINDOW_STEPS = 1;

/** Decodes an RFC 4648 base32 string (the format every authenticator app's
 * QR provisioning uses) into a Buffer. Case-insensitive, ignores padding
 * ('=') and whitespace, which is how secrets get entered by hand. */
export function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/[=\s]/g, '');
  let bits = '';
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character in TOTP secret');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** HOTP (RFC 4226): HMAC-SHA1 over the 8-byte big-endian counter, dynamic
 * truncation, modulo 10^DIGITS. */
function hotp(secretBuf, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Generates the current TOTP code for `secret` (base32) at `now` (ms). */
export function generateTotp(secret, now = Date.now()) {
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secret), counter);
}

/** Constant-time digit-string comparison. */
function safeEqualDigits(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a presented code against `secret`, tolerating clock drift of up
 * to WINDOW_STEPS periods in either direction. Returns a boolean; never
 * throws (a malformed secret/code is just a non-match).
 */
export function verifyTotp(secret, code, now = Date.now()) {
  if (!secret || !code || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  try {
    const secretBuf = base32Decode(secret);
    const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
    for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step++) {
      if (safeEqualDigits(hotp(secretBuf, counter + step), code)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
