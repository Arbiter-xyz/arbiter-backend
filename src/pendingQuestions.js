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

/**
 * Cross-instance quorum answer routing (issue #160).
 *
 * The collector/quorum state machine for a pending question stays in-memory
 * on whichever instance dispatched it (see dispatch.js's `collectors` Map).
 * Only the *routing* of an answer to the owning collector crosses the
 * instance boundary: the owning instance subscribes to a channel keyed by
 * questionId, and any instance that receives an answer for a question it
 * does not own publishes it to that channel instead of assuming ownership.
 *
 * Transport choice: Redis pub/sub, not Streams. Answers are only useful to a
 * collector that is still live and in-memory; a collector that has already
 * settled or timed out has no use for a replayed answer, so Streams' ordering
 * and replay guarantees buy nothing here while adding consumer-group and
 * trimming bookkeeping. Pub/sub's fire-and-forget semantics match the
 * collector's own lifetime exactly. The crash-mid-collection case is handled
 * by the existing TTL/timeout path (PENDING_QUESTION_TTL_MS), not by replay.
 *
 * When Redis is not configured, store.publish/subscribe fall back to an
 * in-process bus, so single-instance behavior is unchanged and adds no new
 * failure mode.
 */
const ANSWER_CHANNEL_PREFIX = 'quorum-answer:';

function answerChannel(questionId) {
  return ANSWER_CHANNEL_PREFIX + questionId.toString();
}

/**
 * Subscribe to answers for a question this instance owns. `onAnswer` is
 * invoked with the answer payload for every answer published by any
 * instance. Returns an unsubscribe function the collector must call when it
 * settles or times out, so a dead collector doesn't leak a subscription.
 */
export async function subscribeToAnswers(questionId, onAnswer) {
  return store.subscribe(answerChannel(questionId), onAnswer);
}

/**
 * Publish an answer for a question this instance does NOT own, so the
 * dispatching instance's collector can count it toward quorum. Safe to call
 * even when this instance happens to own the collector too — the owner's own
 * subscription will receive it, so callers don't need to know ownership.
 */
export async function publishAnswer(questionId, answer) {
  await store.publish(answerChannel(questionId), answer);
}
