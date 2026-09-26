import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPendingQuestion,
  snapshotPendingIds,
  sweepPendingQuestions,
  recordSweepMetrics,
  runRecoverySweep,
} from '../src/disasterRecovery.js';
import { registry } from '../src/metrics.js';

const LEDGER = 10_000;
const NOW = 1_800_000_000_000;
const pending = (overrides = {}) => ({ status: 'pending', payer: 'GPAYER', amount: 5_000_000n, createdAt: LEDGER - 100, ...overrides });

describe('classifyPendingQuestion', () => {
  const classify = (input, opts = {}) => classifyPendingQuestion({ currentLedger: LEDGER, ...input }, { now: NOW, ...opts });

  test('no job and no stash (state lost) is an orphan to refund', () => {
    assert.deepEqual(classify({ question: pending() }), { action: 'refund', reason: 'orphaned' });
  });

  test('a question opened only a few ledgers ago is left alone', () => {
    assert.deepEqual(classify({ question: pending({ createdAt: LEDGER - 3 }) }), { action: 'skip', reason: 'too_young' });
  });

  test('a stash without a job means the payer may still call step 2', () => {
    assert.deepEqual(classify({ question: pending(), stash: { question: 'q' } }), { action: 'skip', reason: 'awaiting_submission' });
  });

  for (const status of ['holding', 'awaiting_workers', 'reconciling', 'cancelling']) {
    test(`a live ${status} job is owned by the normal pipeline`, () => {
      const job = { status, updatedAt: NOW - 60_000 };
      assert.deepEqual(classify({ question: pending(), job }), { action: 'skip', reason: 'inflight' });
    });
  }

  test('an in-flight job nobody has touched for staleInflightMs is refunded', () => {
    const job = { status: 'awaiting_workers', updatedAt: NOW - 31 * 60_000 };
    assert.deepEqual(classify({ question: pending(), job }), { action: 'refund', reason: 'stale_inflight' });
  });

  test('a job whose resolve() and refund() both failed is refunded', () => {
    const job = { status: 'settled', outcome: 'refund_pending_timeout' };
    assert.deepEqual(classify({ question: pending(), job }), { action: 'refund', reason: 'failed_settlement' });
  });

  test('settled locally as resolved but Pending on-chain is flagged, never auto-refunded', () => {
    const job = { status: 'settled', outcome: 'resolved' };
    assert.deepEqual(classify({ question: pending(), job }), { action: 'flag', reason: 'inconsistent' });
  });

  test('anything not Pending on-chain is never touched', () => {
    for (const status of ['resolved', 'refunded', 'migrated']) {
      assert.equal(classify({ question: pending({ status }) }).action, 'skip');
    }
    assert.equal(classify({ question: null }).action, 'skip');
  });
});

describe('snapshotPendingIds', () => {
  test('pages through the whole on-chain index', async () => {
    const all = Array.from({ length: 250 }, (_, i) => String(i + 1));
    const calls = [];
    const snap = await snapshotPendingIds({
      getPendingCount: async () => all.length,
      listPending: async (start, limit) => {
        calls.push(start);
        return all.slice(start, start + limit);
      },
    });
    assert.deepEqual(calls, [0, 100, 200]);
    assert.equal(snap.ids.length, 250);
    assert.equal(snap.consistent, true);
  });

  test('re-scans when the index changed while paging', async () => {
    let counts = [3, 2, 2, 2];
    const snap = await snapshotPendingIds({
      getPendingCount: async () => counts.shift(),
      listPending: async () => ['1', '2'],
    });
    assert.equal(snap.consistent, true);
    assert.deepEqual(snap.ids, ['1', '2']);
  });
});

/** A fake contract + store, enough to run whole sweeps against. */
function world({ questions, jobs = {}, stashes = {}, refundFails = new Set() }) {
  const refunds = [];
  const recorded = [];
  const ids = () => Object.entries(questions).filter(([, q]) => q.status === 'pending').map(([id]) => id);
  return {
    refunds,
    recorded,
    deps: {
      getPendingCount: async () => ids().length,
      listPending: async (start, limit) => ids().slice(start, start + limit),
      getQuestion: async (id) => (questions[id] ? { ...questions[id] } : null),
      getLatestLedger: async () => LEDGER,
      getJob: async (id) => jobs[id] ?? null,
      getStash: async (id) => stashes[id] ?? null,
      refund: async (id) => {
        if (refundFails.has(id)) throw new Error('simulated RPC failure');
        if (questions[id].status !== 'pending') throw new Error('QuestionNotPending');
        questions[id].status = 'refunded';
        refunds.push(id);
        return { hash: `tx-${id}` };
      },
      recordRefund: async (id, info) => recorded.push({ id, ...info }),
    },
  };
}

describe('sweepPendingQuestions', () => {
  test('after total state loss, refunds every stranded question exactly once', async () => {
    const w = world({ questions: { 1: pending(), 2: pending(), 3: pending() } });
    const report = await sweepPendingQuestions(w.deps, { now: NOW });
    assert.deepEqual(w.refunds.sort(), ['1', '2', '3']);
    assert.equal(report.summary.refunded, 3);
    assert.deepEqual(w.recorded.map((r) => r.reason), ['orphaned', 'orphaned', 'orphaned']);

    // Idempotent: a second sweep (e.g. the next interval, or a replica) finds nothing.
    const again = await sweepPendingQuestions(w.deps, { now: NOW });
    assert.equal(again.onChainPending, 0);
    assert.equal(w.refunds.length, 3);
  });

  test('leaves questions the backend can still serve untouched', async () => {
    const w = world({
      questions: { 1: pending(), 2: pending(), 3: pending({ createdAt: LEDGER - 1 }) },
      jobs: { 1: { status: 'awaiting_workers', updatedAt: NOW } },
      stashes: { 2: { question: 'still coming' } },
    });
    const report = await sweepPendingQuestions(w.deps, { now: NOW });
    assert.deepEqual(w.refunds, []);
    assert.deepEqual(report.summary.byReason, { inflight: 1, awaiting_submission: 1, too_young: 1 });
  });

  test('dry run classifies but never refunds', async () => {
    const w = world({ questions: { 1: pending() } });
    const report = await sweepPendingQuestions(w.deps, { now: NOW, dryRun: true });
    assert.deepEqual(w.refunds, []);
    assert.equal(report.items[0].reason, 'orphaned');
    assert.equal(report.items[0].result, undefined);
  });

  test('re-checks on-chain status right before refunding', async () => {
    const w = world({ questions: { 1: pending() } });
    const realGet = w.deps.getQuestion;
    let reads = 0;
    // First read (classification) says Pending; by the pre-refund re-read a
    // concurrent settlement has landed.
    w.deps.getQuestion = async (id) => (++reads === 1 ? realGet(id) : { ...(await realGet(id)), status: 'resolved' });
    const report = await sweepPendingQuestions(w.deps, { now: NOW });
    assert.deepEqual(w.refunds, []);
    assert.equal(report.items[0].result, 'already_settled');
  });

  test('one failing refund does not stop the others', async () => {
    const w = world({ questions: { 1: pending(), 2: pending() }, refundFails: new Set(['1']) });
    const report = await sweepPendingQuestions(w.deps, { now: NOW });
    assert.deepEqual(w.refunds, ['2']);
    assert.equal(report.summary.errors, 1);
  });

  test('caps refunds per sweep and defers the rest', async () => {
    const questions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(i + 1), pending()]));
    const w = world({ questions });
    const report = await sweepPendingQuestions(w.deps, { now: NOW, maxRefundsPerSweep: 2 });
    assert.equal(w.refunds.length, 2);
    assert.equal(report.summary.deferred, 3);
  });
});

describe('recovery metrics', () => {
  const metricValue = async (name, labels) => {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
    return match?.value;
  };

  test('the stranded gauge counts what a sweep could not clear', async () => {
    const w = world({ questions: { 1: pending(), 2: pending() }, refundFails: new Set(['1']) });
    recordSweepMetrics(await sweepPendingQuestions(w.deps, { now: NOW }));
    assert.equal(await metricValue('arbiter_recovery_actionable_pending_questions', { reason: 'orphaned' }), 1);
    assert.equal(await metricValue('arbiter_recovery_refunds_total', { reason: 'orphaned', result: 'error' }), 1);

    // Next sweep succeeds: the gauge drops back to zero, clearing the alert.
    w.deps.refund = async (id) => ({ hash: `tx-${id}` });
    recordSweepMetrics(await sweepPendingQuestions(w.deps, { now: NOW }));
    assert.equal(await metricValue('arbiter_recovery_actionable_pending_questions', { reason: 'orphaned' }), 0);
  });

  test('a flagged inconsistency stays on the gauge', async () => {
    const w = world({ questions: { 1: pending() }, jobs: { 1: { status: 'settled', outcome: 'resolved' } } });
    recordSweepMetrics(await sweepPendingQuestions(w.deps, { now: NOW }));
    assert.equal(await metricValue('arbiter_recovery_actionable_pending_questions', { reason: 'inconsistent' }), 1);
  });
});

describe('runRecoverySweep', () => {
  function lockStore() {
    const keys = new Map();
    return {
      setNX: async (k, v) => (keys.has(k) ? false : (keys.set(k, v), true)),
      delete: async (k) => keys.delete(k),
      keys,
    };
  }

  test('only one sweep at a time acts, and the lock is released afterwards', async () => {
    const store = lockStore();
    store.keys.set('recovery:sweep-lock', 'other-instance');
    const w = world({ questions: { 1: pending() } });
    assert.equal(await runRecoverySweep({ store, deps: w.deps, options: { now: NOW } }), null);
    assert.deepEqual(w.refunds, []);

    store.keys.clear();
    const report = await runRecoverySweep({ store, deps: w.deps, options: { now: NOW } });
    assert.equal(report.summary.refunded, 1);
    assert.equal(store.keys.size, 0);
  });

  test('a chain scan failure is counted and rethrown, and still releases the lock', async () => {
    const store = lockStore();
    const w = world({ questions: {} });
    w.deps.getPendingCount = async () => {
      throw new Error('simulation of pending_count failed');
    };
    await assert.rejects(runRecoverySweep({ store, deps: w.deps }), /pending_count/);
    assert.equal(store.keys.size, 0);
  });
});
