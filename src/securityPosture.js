/**
 * Startup security-posture check. Three pieces of config default to
 * "insecure but convenient" for local dev — wide-open CORS, plaintext
 * Redis, a random per-process SESSION_SECRET — and each is documented as
 * "lock this down for a real deployment," but nothing ever enforced it.
 * This runs once at boot and makes a real deployment that left any of them
 * at the insecure default say so loudly (or refuse to start at all).
 *
 * Everything here is a pure function of an env object, so each check is
 * unit-testable without booting a server (see test/securityPosture.test.js).
 *
 * "Does this look like a real deployment?" deliberately does NOT rely only
 * on NODE_ENV=production — that's exactly the kind of setting someone
 * forgets, which would turn this check into one more silent default. Any
 * ONE of the signals below is enough, and the strongest ones are set by the
 * hosting platform itself, not by the operator. Just as deliberately, there
 * is no "force development mode" override: a variable that switches the
 * check off is a variable that can ship switched off.
 */

const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

// Set automatically by the hosting platform — can't be forgotten.
const HOSTING_PLATFORM_MARKERS = [
  ['RAILWAY_ENVIRONMENT', 'Railway'],
  ['RENDER', 'Render'],
  ['FLY_APP_NAME', 'Fly.io'],
  ['DYNO', 'Heroku'],
  ['K_SERVICE', 'Google Cloud Run'],
  ['AWS_EXECUTION_ENV', 'AWS (ECS/Lambda)'],
  ['KUBERNETES_SERVICE_HOST', 'Kubernetes'],
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.') || hostname.endsWith('.localhost');
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Every reason this env looks like a real deployment rather than local
 * dev. Empty array = local dev. */
export function productionSignals(env) {
  const signals = [];
  if (env.NODE_ENV === 'production') signals.push('NODE_ENV=production');
  if (env.ARBITER_ENV === 'production') signals.push('ARBITER_ENV=production');
  if (env.NETWORK_PASSPHRASE === MAINNET_PASSPHRASE) signals.push('NETWORK_PASSPHRASE is Stellar mainnet');

  const redis = env.REDIS_URL ? parseUrl(env.REDIS_URL) : null;
  if (redis && redis.hostname && !isLoopbackHost(redis.hostname)) {
    signals.push(`REDIS_URL points at a non-local host (${redis.hostname})`);
  }

  for (const [name, platform] of HOSTING_PLATFORM_MARKERS) {
    if (env[name]) signals.push(`${name} is set (${platform})`);
  }
  return signals;
}

/**
 * Returns `{ production, signals, findings }`. Each finding names the exact
 * setting, why it's a problem, and how to fix it. `severity: 'fatal'` means
 * the process must not start; `'error'` means log loudly and continue.
 * Findings are only ever produced when `production` is true — local dev
 * with every default left alone gets an empty list, never noise.
 *
 * Severity, per setting:
 * - SESSION_SECRET unset → fatal. The fallback secret is random per process,
 *   so with more than one replica, sessions issued by one instance are
 *   rejected by every other, and every deploy/restart signs out every
 *   worker and payer. It's never correct in production, and the fix is one
 *   line (`openssl rand -hex 32`).
 * - ALLOWED_ORIGINS wide open → error. This API authenticates with bearer
 *   tokens and session tokens, never cookies, so wildcard CORS doesn't hand
 *   a malicious site anyone's credentials. It does let any origin script
 *   the API from a visitor's browser (see server.js's CORS comment), so
 *   it's worth shouting about, but it's not worth taking a deployment down.
 * - REDIS_URL without TLS → error. Plenty of real deployments run Redis on
 *   a private network (e.g. Railway's internal redis://), where TLS is
 *   optional, so refusing to start would break a legitimate setup. The
 *   warning still makes that trade-off a deliberate choice.
 */
export function evaluateSecurityPosture(env) {
  const signals = productionSignals(env);
  const production = signals.length > 0;
  const findings = [];
  if (!production) return { production, signals, findings };

  if (!env.SESSION_SECRET) {
    findings.push({
      setting: 'SESSION_SECRET',
      severity: 'fatal',
      message:
        'SESSION_SECRET is not set, so worker/payer session tokens are signed with a random per-process secret: ' +
        'every restart signs everyone out, and replicas reject each other\'s tokens. ' +
        'Set it to a stable random value, e.g. `openssl rand -hex 32`.',
    });
  }

  const origins = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) {
    findings.push({
      setting: 'ALLOWED_ORIGINS',
      severity: 'error',
      message:
        `ALLOWED_ORIGINS is ${env.ALLOWED_ORIGINS ? `"${env.ALLOWED_ORIGINS}"` : 'unset (defaults to "*")'}, so CORS is wide open: ` +
        'any website can call this API from a visitor\'s browser. ' +
        'Set it to a comma-separated list of your real frontend origins, e.g. "https://app.example.com".',
    });
  }

  if (env.ARBITER_FAULT_INJECTION === 'true') {
    findings.push({
      setting: 'ARBITER_FAULT_INJECTION',
      severity: 'fatal',
      message:
        'ARBITER_FAULT_INJECTION=true lets an admin-token holder make this API return errors or hang on demand. ' +
        'It exists only for the alert drill (scripts/alert-drill.js) against a non-production deployment. Unset it.',
    });
  }

  if (env.REDIS_URL) {
    const redis = parseUrl(env.REDIS_URL);
    if (redis && redis.protocol !== 'rediss:') {
      findings.push({
        setting: 'REDIS_URL',
        severity: 'error',
        message:
          `REDIS_URL uses ${redis.protocol}// (no TLS), so session, job, and credit-balance state crosses the network unencrypted. ` +
          'Use a rediss:// URL, unless this Redis is reachable only over a private network you trust.',
      });
    }
  }

  return { production, signals, findings };
}

/**
 * Runs the check against `env`, logs every finding through `log`, and
 * returns `false` if any finding is fatal (the caller should then exit
 * non-zero instead of starting the server).
 */
export function enforceSecurityPosture(env, log) {
  const { production, signals, findings } = evaluateSecurityPosture(env);
  if (!production || findings.length === 0) return true;

  for (const f of findings) {
    log.error(
      { setting: f.setting, severity: f.severity, productionSignals: signals },
      `[security-posture] ${f.severity === 'fatal' ? 'REFUSING TO START' : 'INSECURE CONFIG'}: ${f.message}`,
    );
  }
  return !findings.some((f) => f.severity === 'fatal');
}
