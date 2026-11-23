#!/usr/bin/env node
'use strict';

/**
 * Alert drill: inject faults via the admin fault-injection endpoint, wait for
 * the corresponding Prometheus alert to fire, then clear the faults.
 *
 * Usage:
 *   ADMIN_BASE_URL=https://staging.example.com \
 *   ADMIN_TOKEN=... \
 *   node scripts/alert-drill.js [--fault http_error] [--wait 120000]
 *
 * Env:
 *   ADMIN_BASE_URL  Base URL of a non-production deployment (required).
 *   ADMIN_TOKEN     Bearer token for the admin API (required).
 *   ALERT_DRILL_FAULT  Fault type to inject (default: http_error).
 *   ALERT_DRILL_WAIT   Milliseconds to wait for the alert (default: 120000).
 *
 * Exit codes: 0 = drill completed, 1 = failure.
 */

const DEFAULT_FAULT = 'http_error';
const DEFAULT_WAIT_MS = 120000;
const POLL_INTERVAL_MS = 5000;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fault') opts.fault = argv[++i];
    else if (arg === '--wait') opts.wait = Number(argv[++i]);
  }
  return opts;
}

function log(msg) {
  process.stdout.write(`[alert-drill] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[alert-drill] ERROR: ${msg}\n`);
  process.exit(1);
}

async function adminRequest(baseUrl, token, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const baseUrl = process.env.ADMIN_BASE_URL;
  const token = process.env.ADMIN_TOKEN;
  if (!baseUrl) fail('ADMIN_BASE_URL is required');
  if (!token) fail('ADMIN_TOKEN is required');

  const args = parseArgs(process.argv.slice(2));
  const fault = args.fault || process.env.ALERT_DRILL_FAULT || DEFAULT_FAULT;
  const waitMs = args.wait || Number(process.env.ALERT_DRILL_WAIT) || DEFAULT_WAIT_MS;

  log(`injecting fault "${fault}" via ${baseUrl}/admin/faults`);
  await adminRequest(baseUrl, token, 'POST', '/admin/faults', { type: fault });

  log(`waiting up to ${waitMs}ms for the alert to fire`);
  const deadline = Date.now() + waitMs;
  let fired = false;
  while (Date.now() < deadline) {
    const status = await adminRequest(baseUrl, token, 'GET', '/admin/faults');
    if (status && status.alertFiring) {
      fired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  log('clearing injected faults');
  await adminRequest(baseUrl, token, 'DELETE', '/admin/faults');

  if (!fired) fail('alert did not fire within the wait window');
  log('drill complete: alert fired and faults cleared');
}

main().catch((err) => fail(err.message));
