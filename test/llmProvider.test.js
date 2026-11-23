import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConsensusToolInput } from '../src/llmProvider.js';

test('validateConsensusToolInput accepts valid consensus and clamps finite confidence to [0, 1] (#521)', () => {
  const normal = validateConsensusToolInput({
    consensus: 'Yes',
    confidence: 0.85,
    matching_worker_ids: ['w1', 'w2'],
  });
  assert.equal(normal.consensus, 'Yes');
  assert.equal(normal.confidence, 0.85);
  assert.deepEqual(normal.matchingWorkerIds, ['w1', 'w2']);

  const high = validateConsensusToolInput({
    consensus: 'No',
    confidence: 1.5,
    matching_worker_ids: ['w1'],
  });
  assert.equal(high.confidence, 1);

  const low = validateConsensusToolInput({
    consensus: 'No',
    confidence: -0.4,
    matching_worker_ids: ['w1'],
  });
  assert.equal(low.confidence, 0);
});

test('validateConsensusToolInput throws on string confidence, NaN, or missing/empty consensus (#521)', () => {
  assert.throws(
    () => validateConsensusToolInput({ consensus: 'Yes', confidence: '0.9', matching_worker_ids: [] }),
    /confidence must be a finite number/,
  );
  assert.throws(
    () => validateConsensusToolInput({ consensus: 'Yes', confidence: NaN, matching_worker_ids: [] }),
    /confidence must be a finite number/,
  );
  assert.throws(
    () => validateConsensusToolInput({ consensus: '', confidence: 0.8, matching_worker_ids: [] }),
    /consensus must be a non-empty string/,
  );
  assert.throws(
    () => validateConsensusToolInput({ confidence: 0.8, matching_worker_ids: [] }),
    /consensus must be a non-empty string/,
  );
});
