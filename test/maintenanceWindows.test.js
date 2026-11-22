import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WINDOW_MS,
  MAX_REASON_LENGTH,
  MaintenanceWindowError,
  parseWindowInput,
  computePause,
} from '../src/maintenanceWindows.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

test('parseWindowInput accepts ISO strings and epoch milliseconds', () => {
  const fromIso = parseWindowInput(
    { startsAt: '2026-01-01T01:00:00.000Z', endsAt: '2026-01-01T02:00:00.000Z', reason: '  upgrade  ' },
    NOW,
  );
  assert.deepEqual(fromIso, { startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR, reason: 'upgrade' });

  const fromMs = parseWindowInput({ startsAt: NOW, endsAt: NOW + HOUR }, NOW);
  assert.deepEqual(fromMs, { startsAt: NOW, endsAt: NOW + HOUR, reason: null });
});

test('parseWindowInput rejects missing or invalid timestamps', () => {
  assert.throws(() => parseWindowInput({}, NOW), MaintenanceWindowError);
  assert.throws(() => parseWindowInput({ startsAt: 'nope', endsAt: NOW + HOUR }, NOW), MaintenanceWindowError);
});

test('parseWindowInput rejects an end before the start or in the past', () => {
  assert.throws(() => parseWindowInput({ startsAt: NOW + HOUR, endsAt: NOW }, NOW), /after startsAt/);
  assert.throws(() => parseWindowInput({ startsAt: NOW - 2 * HOUR, endsAt: NOW - HOUR }, NOW), /past/);
});

test('parseWindowInput rejects windows longer than the maximum', () => {
  assert.throws(
    () => parseWindowInput({ startsAt: NOW, endsAt: NOW + MAX_WINDOW_MS + 1 }, NOW),
    /at most/,
  );
});

test('parseWindowInput rejects a non-string or over-long reason', () => {
  assert.throws(() => parseWindowInput({ startsAt: NOW, endsAt: NOW + HOUR, reason: 42 }, NOW), /reason/);
  assert.throws(
    () => parseWindowInput({ startsAt: NOW, endsAt: NOW + HOUR, reason: 'x'.repeat(MAX_REASON_LENGTH + 1) }, NOW),
    /reason/,
  );
});

test('computePause returns null when no window is active', () => {
  assert.equal(computePause([], NOW), null);
  assert.equal(computePause([{ id: 'a', startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR }], NOW), null);
});

test('computePause extends across touching windows', () => {
  const windows = [
    { id: 'a', reason: 'first', startsAt: NOW - HOUR, endsAt: NOW + HOUR },
    { id: 'b', reason: 'second', startsAt: NOW + HOUR, endsAt: NOW + 3 * HOUR },
  ];
  assert.deepEqual(computePause(windows, NOW), {
    windowId: 'a',
    reason: 'first',
    startsAt: NOW - HOUR,
    resumesAt: NOW + 3 * HOUR,
  });
});
