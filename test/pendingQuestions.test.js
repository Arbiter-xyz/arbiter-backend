import test from 'node:test';
import assert from 'node:assert/strict';
import { nextQuestionId } from '../src/pendingQuestions.js';

test('nextQuestionId returns unique values within a process', async () => {
  const ids = await Promise.all(Array.from({ length: 20 }, () => nextQuestionId()));
  const unique = new Set(ids.map((id) => id.toString()));
  assert.equal(unique.size, ids.length, 'all ids must be unique');
});

test("nextQuestionId values fit within u64 range (the contract's question_id type)", async () => {
  const id = await nextQuestionId();
  assert.ok(id >= 0n);
  assert.ok(id <= 2n ** 64n - 1n);
});

test('ids minted by this process share a common high-32-bit salt (defense-in-depth against cross-process collisions)', async () => {
  const a = await nextQuestionId();
  const b = await nextQuestionId();
  assert.equal(a >> 32n, b >> 32n);
});

test('the low 32 bits increment monotonically within a process', async () => {
  const a = await nextQuestionId();
  const b = await nextQuestionId();
  const lowA = a & 0xffffffffn;
  const lowB = b & 0xffffffffn;
  assert.ok(lowB > lowA);
});
