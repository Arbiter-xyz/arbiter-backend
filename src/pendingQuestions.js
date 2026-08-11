import { randomBytes } from 'node:crypto';
import { store } from './store.js';
import { config } from './config.js';

const PREFIX = 'pending:';

/**
 * A random-per-process 32-bit salt, mixed into the high bits of every
 * question id this process mints. store.incr() on its own gives a
 * globally-unique, atomic sequence when Redis is configured — but the
 * in-memory fallback can only coordinate a sequence WITHIN its own process.
 * Two backend instances both running memory-only (e.g. an accidental
 * horizontal-scale deployment without REDIS_URL set) would otherwise mint
 * colliding ids, which doesn't just corrupt in-memory state — it makes a
 * real payer's on-chain submit() call fail with QuestionAlreadyExists.
 * Salting collapses that from "guaranteed collision" to "both processes
 * would need to independently generate the same random 32-bit salt AND the
 * same counter value," which is the same defense-in-depth whether or not
 * Redis is configured, so there's a single code path either way.
 */
const PROCESS_SALT = BigInt('0x' + randomBytes(4).toString('hex'));

const SEQ_KEY = 'question-id-seq';

export async function nextQuestionId() {
  const seq = await store.incr(SEQ_KEY);
  // salt (32 bits) in the high half, sequence (32 bits) in the low half —
  // always fits exactly within u64, the contract's question_id type.
  // Bounded to ~4.29 billion questions per process lifetime/shared counter
  // before the low half could bleed into the salt; nowhere near realistic
  // throughput for this system.
  return (PROCESS_SALT << 32n) | BigInt(seq);
}

export async function stashQuestion(questionId, data) {
  await store.set(PREFIX + questionId.toString(), data, config.pendingQuestionTtlMs);
}

export async function getStashedQuestion(questionId) {
  return store.get(PREFIX + questionId.toString());
}

export async function dropStashedQuestion(questionId) {
  await store.delete(PREFIX + questionId.toString());
}
