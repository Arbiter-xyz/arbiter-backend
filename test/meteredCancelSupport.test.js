import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendAuditLog, listAuditLog, _resetAuditLogForTesting } from '../src/auditLog.js';
import { listTickets } from '../src/support.js';
import { summarizePayerQuestions } from '../src/payerIndex.js';
import { resolveQuestionsBatch, refundQuestionsBatch } from '../src/stellarClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('src/support.js imports smoothly now that src/auditLog.js exists (#246)', async () => {
  await _resetAuditLogForTesting();
  const tickets = await listTickets();
  assert.ok(Array.isArray(tickets));

  const entry = await appendAuditLog({
    action: 'support.ticket.create',
    actor: 'GTEST_ACTOR',
    target: 'ticket-123',
    metadata: { questionId: 'q-123' },
  });
  assert.equal(entry.action, 'support.ticket.create');
  assert.equal(entry.actor, 'GTEST_ACTOR');

  const log = await listAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].target, 'ticket-123');
});

test('resolveQuestionsBatch and refundQuestionsBatch refuse speculative execution by default (#233)', async () => {
  await assert.rejects(
    () => resolveQuestionsBatch([{ questionId: 'q1', workerAddress: 'G1', outcome: true }]),
    /arbiter-contract#20/
  );
  await assert.rejects(
    () => refundQuestionsBatch(['q1']),
    /arbiter-contract#20/
  );
});

test('summarizePayerQuestions exposes both cancellableUntil and cancelableUntil aliases plus cancelUrl (#235)', () => {
  const qid = 'q-cancel-alias-235';
  const futureIso = new Date(Date.now() + 60_000).toISOString();

  const summary = summarizePayerQuestions(
    [qid],
    [
      {
        question: 'Is cancelableUntil exposed?',
        rewardStroops: '250000',
        status: 'in_progress',
        cancellableUntil: futureIso,
      },
    ]
  );

  const found = summary.questions.find((q) => q.questionId === qid);
  assert.ok(found, 'Expected indexed question in summary');
  assert.equal(found.cancellableUntil, futureIso);
  assert.equal(found.cancelableUntil, futureIso);
  assert.equal(found.cancelUrl, `/oracle/${qid}/cancel`);
});

test('src/metered.js defines consensusRule parameter and destructures cancellableUntil from startFulfillment (#231, #235)', () => {
  const meteredSrc = readFileSync(path.join(__dirname, '..', 'src', 'metered.js'), 'utf8');
  assert.match(meteredSrc, /\{\s*ownerAccountId,\s*consensusRule\s*\}\s*=\s*\{\}/);
  assert.match(meteredSrc, /const\s*\{\s*jobId,\s*cancellableUntil\s*\}\s*=\s*await\s+startFulfillment\(/);
  assert.match(meteredSrc, /cancelableUntil:\s*cancellableUntil/);
});

