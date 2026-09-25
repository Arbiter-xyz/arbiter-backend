import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsp, securityHeaders } from '../src/securityHeaders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('CSP is strict: same-origin scripts only, no inline/eval script, no framing, no plugins', () => {
  const csp = buildCsp();
  const directive = (name) => csp.split('; ').find((d) => d.startsWith(`${name} `));
  assert.equal(directive('default-src'), "default-src 'self'");
  assert.equal(directive('script-src'), "script-src 'self'");
  assert.equal(directive('object-src'), "object-src 'none'");
  assert.equal(directive('frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directive('base-uri'), "base-uri 'self'");
  assert.ok(!/unsafe-eval/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/\*/.test(csp), 'no wildcard sources');
});

test('connectSrc extends only connect-src', () => {
  const csp = buildCsp({ connectSrc: ['https://ui.example.com'] });
  assert.match(csp, /connect-src 'self' https:\/\/ui\.example\.com/);
  assert.ok(!/script-src[^;]*ui\.example\.com/.test(csp));
});

test('securityHeaders includes the four required headers, and HSTS can be disabled', () => {
  const h = securityHeaders();
  assert.ok(h['Content-Security-Policy']);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.match(h['Strict-Transport-Security'], /^max-age=\d+/);
  assert.equal(securityHeaders({ hsts: false })['Strict-Transport-Security'], undefined);
});

describe('headers on live responses', () => {
  let child;
  let base;
  before(async () => {
    const port = 5200 + Math.floor(Math.random() * 500);
    base = `http://localhost:${port}`;
    child = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), CSP_CONNECT_SRC: 'https://ui.example.com' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (c) => c.toString().includes('listening on') && resolve());
      child.on('exit', (code) => reject(new Error(`server exited early: ${code}`)));
      setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    });
  });
  after(() => child.kill());

  for (const route of ['/health', '/stats', '/leaderboard']) {
    test(`${route} carries security headers`, async () => {
      const res = await fetch(base + route);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.match(res.headers.get('strict-transport-security'), /max-age=/);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /connect-src 'self' https:\/\/ui\.example\.com/);
    });
  }
});
