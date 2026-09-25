import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWorker,
  unregisterWorker,
  dispatchAndCollect,
  submitAnswer,
  buildSuggestionPayload,
} from '../src/dispatch.js';
import { shouldDraftSuggestion } from '../src/oracle.js';
import { PRICING_TIERS } from '../src/pricing.js';

function fakeRes() {
  const events = [];
  return { events, write: (chunk) => events.push(chunk) };
}

/** Parses the raw SSE frames a fake response collected into { event, data } pairs. */
function sseEvents(res) {
  return res.events.map((chunk) => {
    const [eventLine, dataLine] = chunk.trim().split('\n');
    return { event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
  });
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DRAFT = { consensus: 'Paris', confidence: 0.92, matchingWorkerIds: [], method: 'llm-draft' };

test('a resolved draft is delivered as a follow-up suggestion event after the question', async () => {
  const w = fakeRes();
  registerWorker('sugg-worker-1', w, []);
  try {
    const collected = dispatchAndCollect('q-sugg-1', 'Capital of France?', {
      quorumSize: 1,
      timeoutMs: 2000,
      suggestion: Promise.resolve(DRAFT),
    });
    await tick();

    const events = sseEvents(w);
    assert.deepEqual(events.map((e) => e.event), ['question', 'suggestion']);
    assert.equal(events[0].data.suggestedAnswer, undefined, 'the question payload itself is unchanged');
    assert.deepEqual(events[1].data, buildSuggestionPayload('q-sugg-1', DRAFT));
    assert.equal(events[1].data.suggestedAnswer, 'Paris');
    assert.equal(events[1].data.suggestedConfidence, 0.92);
    assert.equal(events[1].data.unverified, true);

    submitAnswer('q-sugg-1', 'sugg-worker-1', 'Paris');
    const submissions = await collected;
    assert.equal(submissions.length, 1, 'the suggestion never counts as a submission');
  } finally {
    unregisterWorker('sugg-worker-1');
  }
});

test('the question is broadcast immediately — a slow draft never delays it', async () => {
  const w = fakeRes();
  registerWorker('sugg-worker-2', w, []);
  let releaseDraft;
  const slowDraft = new Promise((resolve) => (releaseDraft = resolve));
  try {
    const collected = dispatchAndCollect('q-sugg-2', 'Slow draft?', { quorumSize: 1, timeoutMs: 2000, suggestion: slowDraft });
    await tick();
    assert.deepEqual(sseEvents(w).map((e) => e.event), ['question'], 'question delivered before the draft exists');

    releaseDraft(DRAFT);
    await tick();
    assert.deepEqual(sseEvents(w).map((e) => e.event), ['question', 'suggestion']);

    submitAnswer('q-sugg-2', 'sugg-worker-2', 'x');
    await collected;
  } finally {
    unregisterWorker('sugg-worker-2');
  }
});

test('a failed draft (null or rejected) sends no suggestion and dispatch proceeds normally', async () => {
  for (const [label, makeSuggestion] of [
    ['null', () => Promise.resolve(null)],
    ['rejected', () => Promise.reject(new Error('claude down'))],
  ]) {
    const suggestion = makeSuggestion();
    const w = fakeRes();
    const workerId = `sugg-worker-fail-${label}`;
    registerWorker(workerId, w, []);
    try {
      const qid = `q-sugg-fail-${label}`;
      const collected = dispatchAndCollect(qid, 'Q?', { quorumSize: 1, timeoutMs: 2000, suggestion });
      await tick();
      assert.deepEqual(sseEvents(w).map((e) => e.event), ['question'], `${label}: only the question is sent`);

      assert.equal(submitAnswer(qid, workerId, 'answer'), true);
      assert.equal((await collected).length, 1);
    } finally {
      unregisterWorker(workerId);
    }
  }
});

test('with suggestions disabled (no suggestion passed) dispatch behaves exactly as before', async () => {
  const w = fakeRes();
  registerWorker('sugg-worker-3', w, []);
  try {
    const collected = dispatchAndCollect('q-sugg-3', 'Q?', { quorumSize: 1, timeoutMs: 2000 });
    await tick();
    assert.deepEqual(sseEvents(w).map((e) => e.event), ['question']);
    submitAnswer('q-sugg-3', 'sugg-worker-3', 'a');
    await collected;
  } finally {
    unregisterWorker('sugg-worker-3');
  }
});

test('a draft that arrives after the question has closed is dropped', async () => {
  const w = fakeRes();
  registerWorker('sugg-worker-4', w, []);
  let releaseDraft;
  try {
    const collected = dispatchAndCollect('q-sugg-4', 'Q?', {
      quorumSize: 1,
      timeoutMs: 2000,
      suggestion: new Promise((resolve) => (releaseDraft = resolve)),
    });
    await tick();
    submitAnswer('q-sugg-4', 'sugg-worker-4', 'done');
    await collected;

    releaseDraft(DRAFT);
    await tick();
    assert.deepEqual(sseEvents(w).map((e) => e.event), ['question']);
  } finally {
    unregisterWorker('sugg-worker-4');
  }
});

test('a worker that disconnected before the draft arrived is skipped without error', async () => {
  const stays = fakeRes();
  const leaves = fakeRes();
  registerWorker('sugg-worker-stays', stays, []);
  registerWorker('sugg-worker-leaves', leaves, []);
  let releaseDraft;
  try {
    const collected = dispatchAndCollect('q-sugg-5', 'Q?', {
      quorumSize: 2,
      timeoutMs: 300,
      suggestion: new Promise((resolve) => (releaseDraft = resolve)),
    });
    await tick();
    unregisterWorker('sugg-worker-leaves');
    releaseDraft(DRAFT);
    await tick();

    assert.deepEqual(sseEvents(stays).map((e) => e.event), ['question', 'suggestion']);
    assert.deepEqual(sseEvents(leaves).map((e) => e.event), ['question']);
    await collected;
  } finally {
    unregisterWorker('sugg-worker-stays');
  }
});

test('shouldDraftSuggestion: opt-in, needs an API key, respects the tier list, never for instant', () => {
  const on = { enabled: true, apiKey: 'sk-test', tiers: ['standard', 'express', 'priority'] };

  assert.equal(shouldDraftSuggestion(PRICING_TIERS.standard, on), true);
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.priority, on), true);
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.instant, { ...on, tiers: ['instant'] }), false);
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.standard, { ...on, enabled: false }), false);
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.standard, { ...on, apiKey: '' }), false);
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.express, { ...on, tiers: ['priority'] }), false);
  assert.equal(shouldDraftSuggestion(undefined, on), false);
});

test('shouldDraftSuggestion defaults to off (DRAFT_SUGGESTIONS_ENABLED unset)', () => {
  assert.equal(shouldDraftSuggestion(PRICING_TIERS.standard), false);
});
