import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionSignals, evaluateSecurityPosture, enforceSecurityPosture } from '../src/securityPosture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECURE_PROD = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'a'.repeat(64),
  ALLOWED_ORIGINS: 'https://app.example.com',
  REDIS_URL: 'rediss://default:pw@redis.example.com:6380',
};

function settingsOf(result) {
  return result.findings.map((f) => f.setting).sort();
}

describe('productionSignals', () => {
  test('a bare local-dev env (every default untouched) has no production signal', () => {
    assert.deepEqual(productionSignals({}), []);
  });

  test('local Redis, testnet, and a non-production NODE_ENV are not production signals', () => {
    assert.deepEqual(
      productionSignals({
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      }),
      [],
    );
    assert.deepEqual(productionSignals({ REDIS_URL: 'redis://127.0.0.1:6379/0' }), []);
    assert.deepEqual(productionSignals({ REDIS_URL: 'redis://[::1]:6379' }), []);
  });

  test('each independent signal is enough on its own, even without NODE_ENV=production', () => {
    assert.equal(productionSignals({ NODE_ENV: 'production' }).length, 1);
    assert.equal(productionSignals({ ARBITER_ENV: 'production' }).length, 1);
    assert.equal(productionSignals({ NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015' }).length, 1);
    assert.equal(productionSignals({ REDIS_URL: 'redis://redis.railway.internal:6379' }).length, 1);
    assert.equal(productionSignals({ RAILWAY_ENVIRONMENT: 'production' }).length, 1);
    assert.equal(productionSignals({ FLY_APP_NAME: 'arbiter' }).length, 1);
    assert.equal(productionSignals({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }).length, 1);
  });

  test('an unparseable REDIS_URL is not treated as a signal (store.js reports the bad URL itself)', () => {
    assert.deepEqual(productionSignals({ REDIS_URL: 'not a url' }), []);
  });
});

describe('evaluateSecurityPosture', () => {
  test('local dev with all three insecure defaults produces no findings at all', () => {
    const result = evaluateSecurityPosture({ ALLOWED_ORIGINS: '*', REDIS_URL: 'redis://localhost:6379' });
    assert.equal(result.production, false);
    assert.deepEqual(result.findings, []);
  });

  test('a securely configured production env produces no findings', () => {
    const result = evaluateSecurityPosture(SECURE_PROD);
    assert.equal(result.production, true);
    assert.deepEqual(result.findings, []);
  });

  test('production with all three insecure defaults flags all three by name', () => {
    const result = evaluateSecurityPosture({ NODE_ENV: 'production', REDIS_URL: 'redis://redis.example.com:6379' });
    assert.deepEqual(settingsOf(result), ['ALLOWED_ORIGINS', 'REDIS_URL', 'SESSION_SECRET']);
  });

  test('SESSION_SECRET unset in production is fatal, and the message says why and how to fix it', () => {
    const { SESSION_SECRET, ...env } = SECURE_PROD;
    const [finding] = evaluateSecurityPosture(env).findings;
    assert.equal(finding.setting, 'SESSION_SECRET');
    assert.equal(finding.severity, 'fatal');
    assert.match(finding.message, /random per-process secret/);
    assert.match(finding.message, /openssl rand -hex 32/);
  });

  test('ALLOWED_ORIGINS unset, "*", or containing "*" in production is an error, not fatal', () => {
    for (const ALLOWED_ORIGINS of [undefined, '*', 'https://app.example.com, *']) {
      const findings = evaluateSecurityPosture({ ...SECURE_PROD, ALLOWED_ORIGINS }).findings;
      assert.equal(findings.length, 1, `ALLOWED_ORIGINS=${ALLOWED_ORIGINS}`);
      assert.equal(findings[0].setting, 'ALLOWED_ORIGINS');
      assert.equal(findings[0].severity, 'error');
    }
  });

  test('a non-TLS REDIS_URL in production is an error; rediss:// passes', () => {
    const plain = evaluateSecurityPosture({ ...SECURE_PROD, REDIS_URL: 'redis://redis.example.com:6379' }).findings;
    assert.equal(plain.length, 1);
    assert.equal(plain[0].setting, 'REDIS_URL');
    assert.equal(plain[0].severity, 'error');
    assert.match(plain[0].message, /redis:\/\/ \(no TLS\)/);
  });

  test('a platform marker alone (no NODE_ENV) still catches a missing SESSION_SECRET', () => {
    const result = evaluateSecurityPosture({ RENDER: 'true', ALLOWED_ORIGINS: 'https://app.example.com' });
    assert.deepEqual(settingsOf(result), ['SESSION_SECRET']);
  });
});

describe('enforceSecurityPosture', () => {
  function captureLog() {
    const lines = [];
    return { lines, log: { error: (obj, msg) => lines.push({ obj, msg }) } };
  }

  test('returns true and logs nothing in local dev', () => {
    const { lines, log } = captureLog();
    assert.equal(enforceSecurityPosture({ ALLOWED_ORIGINS: '*' }, log), true);
    assert.equal(lines.length, 0);
  });

  test('returns true (keeps running) but logs every non-fatal finding', () => {
    const { lines, log } = captureLog();
    assert.equal(enforceSecurityPosture({ ...SECURE_PROD, ALLOWED_ORIGINS: '*' }, log), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0].msg, /INSECURE CONFIG: ALLOWED_ORIGINS/);
    assert.ok(lines[0].obj.productionSignals.includes('NODE_ENV=production'));
  });

  test('returns false when any finding is fatal', () => {
    const { lines, log } = captureLog();
    const { SESSION_SECRET, ...env } = SECURE_PROD;
    assert.equal(enforceSecurityPosture(env, log), false);
    assert.match(lines[0].msg, /REFUSING TO START: SESSION_SECRET/);
  });
});

describe('server startup', () => {
  // Start from the parent env minus anything that would itself read as a
  // production signal (e.g. a CI runner that happens to live in Kubernetes),
  // so each case below controls the posture it's testing.
  const PRODUCTION_SIGNAL_VARS = ['NODE_ENV', 'ARBITER_ENV', 'NETWORK_PASSPHRASE', 'REDIS_URL', 'RAILWAY_ENVIRONMENT', 'RENDER', 'FLY_APP_NAME', 'DYNO', 'K_SERVICE', 'AWS_EXECUTION_ENV', 'KUBERNETES_SERVICE_HOST'];
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PRODUCTION_SIGNAL_VARS.includes(k)));

  function boot(extraEnv) {
    return new Promise((resolve) => {
      const child = spawn('node', ['src/server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...baseEnv, PORT: String(4700 + Math.floor(Math.random() * 200)), LOG_FORMAT: 'json', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        if (out.includes('listening on')) child.kill();
      });
      child.stderr.on('data', (c) => (out += c));
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  }

  test('a production-looking deployment without SESSION_SECRET exits non-zero and names the setting', async () => {
    const { code, out } = await boot({ NODE_ENV: 'production', SESSION_SECRET: '', ALLOWED_ORIGINS: 'https://app.example.com' });
    assert.equal(code, 1);
    assert.match(out, /REFUSING TO START: SESSION_SECRET/);
    assert.doesNotMatch(out, /listening on/);
  });

  test('local dev with the same defaults starts normally with no security-posture output', async () => {
    const { out } = await boot({ SESSION_SECRET: '', ALLOWED_ORIGINS: '*' });
    assert.match(out, /listening on/);
    assert.doesNotMatch(out, /security-posture/);
  });
});
