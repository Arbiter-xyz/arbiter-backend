import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@stellar/stellar-sdk';

import {
  createTicket,
  listTickets,
  getTicket,
  respondToTicket,
  isQuestionLinkedToAddress,
} from '../src/support.js';
import {
  buildChallengeXdr,
  verifyChallengeAndIssueSession,
} from '../src/workerAuth.js';
import { recordPayerQuestion } from '../src/payerIndex.js';
import { createJob } from '../src/jobs.js';
import { config } from '../src/config.js';

async function mintSessionForKeypair(kp) {
  const challengeXdr = await buildChallengeXdr(kp.publicKey());
  const tx = new Transaction(challengeXdr, config.networkPassphrase);
  tx.sign(kp);
  const session = await verifyChallengeAndIssueSession(kp.publicKey(), tx.toXDR());
  assert.ok(session?.token);
  return session.token;
}

test('isQuestionLinkedToAddress verifies payer and worker linkage and rejects unlinked addresses', async () => {
  const payer = Keypair.random().publicKey();
  const worker = Keypair.random().publicKey();
  const stranger = Keypair.random().publicKey();

  await recordPayerQuestion(payer, 'q-payer-1');
  await createJob('q-worker-1', { question: 'Test?', workerId: worker });

  assert.equal(await isQuestionLinkedToAddress(payer, 'q-payer-1'), true);
  assert.equal(await isQuestionLinkedToAddress(worker, 'q-worker-1'), true);
  assert.equal(await isQuestionLinkedToAddress(stranger, 'q-payer-1'), false);
  assert.equal(await isQuestionLinkedToAddress('', 'q-payer-1'), false);
});

test('createTicket validates inputs, enforces session authentication and question linkage', async () => {
  const kpA = Keypair.random();
  const kpB = Keypair.random();
  const tokenA = await mintSessionForKeypair(kpA);
  const tokenB = await mintSessionForKeypair(kpB);

  await assert.rejects(
    () => createTicket('', null, 'help', { sessionToken: tokenA }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => createTicket(kpA.publicKey(), null, '   ', { sessionToken: tokenA }),
    (err) => err.status === 400,
  );

  // Missing or impersonated token -> 401
  await assert.rejects(
    () => createTicket(kpA.publicKey(), null, 'help me', { sessionToken: tokenB }),
    (err) => err.status === 401,
  );

  // Unlinked questionId -> 403
  await assert.rejects(
    () => createTicket(kpA.publicKey(), 'unlinked-q-99', 'about question', { sessionToken: tokenA }),
    (err) => err.status === 403,
  );

  // Linked questionId -> succeeds
  await recordPayerQuestion(kpA.publicKey(), 'linked-q-100');
  const ticket = await createTicket(kpA.publicKey(), 'linked-q-100', '  Settlement delayed  ', {
    sessionToken: tokenA,
  });
  assert.equal(ticket.address, kpA.publicKey());
  assert.equal(ticket.questionId, 'linked-q-100');
  assert.equal(ticket.message, 'Settlement delayed');
  assert.equal(ticket.status, 'open');
});

test('createTicket rate-limits excessive ticket creation per authenticated address (#280)', async () => {
  const kp = Keypair.random();
  const token = await mintSessionForKeypair(kp);
  const addr = kp.publicKey();

  const t1 = await createTicket(addr, null, 'first issue', {
    sessionToken: token,
    maxTicketsPerWindow: 2,
    rateLimitWindowMs: 60_000,
  });
  const t2 = await createTicket(addr, null, 'second issue', {
    sessionToken: token,
    maxTicketsPerWindow: 2,
    rateLimitWindowMs: 60_000,
  });
  assert.ok(t1.ticketId);
  assert.ok(t2.ticketId);

  await assert.rejects(
    () =>
      createTicket(addr, null, 'third issue spam', {
        sessionToken: token,
        maxTicketsPerWindow: 2,
        rateLimitWindowMs: 60_000,
      }),
    (err) => err.status === 429 && /rate limit/i.test(err.message),
  );
});

test('listTickets, getTicket, and respondToTicket manage ticket lifecycle from open to answered and closed', async () => {
  const kp = Keypair.random();
  const token = await mintSessionForKeypair(kp);
  const ticket = await createTicket(kp.publicKey(), null, 'Need payout help', {
    sessionToken: token,
  });

  const fetched = await getTicket(ticket.ticketId);
  assert.equal(fetched.ticketId, ticket.ticketId);

  const openList = await listTickets({ status: 'open' });
  assert.equal(openList.some((t) => t.ticketId === ticket.ticketId), true);

  await assert.rejects(
    () => respondToTicket('missing-id', 'hello'),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => respondToTicket(ticket.ticketId, '   '),
    (err) => err.status === 400,
  );

  const answered = await respondToTicket(ticket.ticketId, 'Checking on-chain ledger now', {
    adminId: 'ops-1',
    close: false,
  });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.responses.length, 1);
  assert.equal(answered.responses[0].adminId, 'ops-1');

  const closed = await respondToTicket(ticket.ticketId, 'Resolved on ledger 1234', {
    adminId: 'ops-1',
    close: true,
  });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.responses.length, 2);

  const stillOpen = await listTickets({ status: 'open' });
  assert.equal(stillOpen.some((t) => t.ticketId === ticket.ticketId), false);
});
