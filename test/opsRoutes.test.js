import './helpers/admin-test-env.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireAdmin } from '../src/adminAuth.js';
import { mountMaintenanceRoutes, getDispatchPause, listUpcomingWindows } from '../src/maintenanceWindows.js';
import { mountTaxAdminRoutes } from '../src/taxReport.js';
import { mountErasureRoutes } from '../src/erasure.js';
import { mountSupportRoutes } from '../src/support.js';
import { recordWorkerCredits } from '../src/earnings.js';
import { recordPayerQuestion, getPayerQuestionIds } from '../src/payerIndex.js';
import { recordAnchorKyc, getAnchorKyc } from '../src/anchorRecords.js';

// Routes for exports #221 found with zero callers, mounted exactly as
// server.js mounts them — through the real requireAdmin() gate — so each
// test proves an HTTP request actually reaches the function behind it.

const ADMIN = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
const PAYER = 'GPAYER' + 'A'.repeat(50);
const SESSION_ADDRESS = 'GSUPPORT' + 'B'.repeat(48);

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  const adminGate = requireAdmin();
  mountMaintenanceRoutes(app, adminGate);
  mountTaxAdminRoutes(app, adminGate);
  mountErasureRoutes(app, adminGate);
  mountSupportRoutes(app, adminGate, { authenticate: async (token) => (token === 'good-session' ? SESSION_ADDRESS : null) });
  ({ server, base } = await listen(app));
});

after(() => server.close());

const call = (method, path, { headers = ADMIN, body } = {}) =>
  fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe('admin gate', () => {
  test('every mounted admin route refuses a request without the admin token', async () => {
    for (const [method, path] of [
      ['POST', '/admin/maintenance-windows'],
      ['DELETE', '/admin/maintenance-windows/mw_x'],
      ['GET', '/admin/tax/summaries'],
      ['DELETE', `/admin/erasure/${PAYER}`],
      ['GET', '/admin/support/tickets'],
    ]) {
      const res = await call(method, path, { headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
});

describe('maintenance windows (addWindow / removeWindow)', () => {
  test('scheduling a window pauses dispatch; deleting it ends the pause', async () => {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await call('POST', '/admin/maintenance-windows', { body: { startsAt, endsAt, reason: 'holiday' } });
    assert.equal(created.status, 201);
    const { window } = await created.json();
    assert.match(window.id, /^mw_/);
    assert.equal(window.endsAt, endsAt);
    assert.equal((await getDispatchPause()).windowId, window.id);
    assert.ok((await listUpcomingWindows()).some((w) => w.id === window.id));

    const removed = await call('DELETE', `/admin/maintenance-windows/${window.id}`);
    assert.equal(removed.status, 200);
    assert.equal(await getDispatchPause(), null);
    assert.equal((await call('DELETE', `/admin/maintenance-windows/${window.id}`)).status, 404);
  });

  test('invalid input is a 400 with the validation message', async () => {
    const res = await call('POST', '/admin/maintenance-windows', { body: { startsAt: 'nope' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /startsAt and endsAt are required/);
  });
});

describe('all-workers tax export (buildAllTaxSummaries / taxSummariesToCsv)', () => {
  const worker = 'GWORKER' + 'C'.repeat(49);

  before(async () => {
    await recordWorkerCredits('tax-q1', [worker], 10_000_000n, 'txhash-1', Date.UTC(2025, 2, 1));
  });

  test('JSON lists every worker with activity in the year', async () => {
    const res = await call('GET', '/admin/tax/summaries?year=2025');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taxYear, 2025);
    assert.ok(body.summaries.some((s) => s.recipient.stellarAddress === worker));
  });

  test('format=csv returns the bulk-import CSV as a download', async () => {
    const res = await call('GET', '/admin/tax/summaries?year=2025&format=csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /arbiter-tax-summaries-2025\.csv/);
    const csv = await res.text();
    assert.match(csv, /^tax_year,stellar_address,/);
    assert.ok(csv.includes(worker));
  });

  test('an out-of-range year is a 400', async () => {
    assert.equal((await call('GET', '/admin/tax/summaries?year=1999')).status, 400);
  });
});

describe('erasure (erasePayerRecords / eraseAnchorRecords)', () => {
  test('erases the payer index and anchor records for an address, and says on-chain state is untouched', async () => {
    await recordPayerQuestion(PAYER, 'erase-q1');
    await recordAnchorKyc(PAYER, { status: 'approved', tier: 1 });

    const res = await call('DELETE', `/admin/erasure/${PAYER}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.erased.payer.questionIds, 1);
    assert.equal(body.erased.payer.removedFromIndex, true);
    assert.equal(body.erased.anchor.kyc, true);
    assert.match(body.notErased, /On-chain records/);

    assert.deepEqual(await getPayerQuestionIds(PAYER), []);
    assert.equal(await getAnchorKyc(PAYER), null);
  });
});

describe('support tickets (createTicket / listTickets / getTicket / respondToTicket)', () => {
  const session = { authorization: 'Bearer good-session', 'content-type': 'application/json' };

  test('creating a ticket requires a valid session token', async () => {
    assert.equal((await call('POST', '/support/tickets', { headers: { 'content-type': 'application/json' }, body: { message: 'hi' } })).status, 401);
    assert.equal((await call('POST', '/support/tickets', { headers: { ...session, authorization: 'Bearer forged' }, body: { message: 'hi' } })).status, 401);
  });

  test('a ticket about a question the caller has no link to is refused', async () => {
    const res = await call('POST', '/support/tickets', { headers: session, body: { message: 'where is my refund', questionId: 'not-mine' } });
    assert.equal(res.status, 403);
  });

  test('open → list → fetch → respond → close, end to end over HTTP', async () => {
    await recordPayerQuestion(SESSION_ADDRESS, 'support-q1');
    const created = await call('POST', '/support/tickets', { headers: session, body: { message: '  stuck question  ', questionId: 'support-q1' } });
    assert.equal(created.status, 201);
    const { ticket } = await created.json();
    assert.equal(ticket.address, SESSION_ADDRESS);
    assert.equal(ticket.message, 'stuck question');
    assert.equal(ticket.status, 'open');

    const open = await (await call('GET', '/admin/support/tickets?status=open')).json();
    assert.ok(open.tickets.some((t) => t.ticketId === ticket.ticketId));
    assert.equal((await call('GET', '/admin/support/tickets?status=bogus')).status, 400);

    const fetched = await (await call('GET', `/admin/support/tickets/${ticket.ticketId}`)).json();
    assert.equal(fetched.ticket.ticketId, ticket.ticketId);

    const answered = await (await call('POST', `/admin/support/tickets/${ticket.ticketId}/respond`, { body: { message: 'refund sent' } })).json();
    assert.equal(answered.ticket.status, 'answered');
    assert.equal(answered.ticket.responses[0].message, 'refund sent');

    const closed = await (await call('POST', `/admin/support/tickets/${ticket.ticketId}/respond`, { body: { message: 'closing', close: true } })).json();
    assert.equal(closed.ticket.status, 'closed');
    assert.equal(closed.ticket.responses.length, 2);
  });

  test('unknown tickets are 404s and empty messages are 400s', async () => {
    assert.equal((await call('GET', '/admin/support/tickets/nope')).status, 404);
    assert.equal((await call('POST', '/admin/support/tickets/nope/respond', { body: { message: 'x' } })).status, 404);
    assert.equal((await call('POST', '/support/tickets', { headers: session, body: { message: '   ' } })).status, 400);
  });
});
