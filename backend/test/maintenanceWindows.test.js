const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWindowInput,
  computePause,
} = require('../src/maintenanceWindows');

test('parseWindowInput parses a valid window', () => {
  const result = parseWindowInput({ start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' });
  assert.equal(result.start.toISOString(), '2024-01-01T00:00:00.000Z');
  assert.equal(result.end.toISOString(), '2024-01-01T02:00:00.000Z');
});

test('parseWindowInput rejects a window whose end precedes start', () => {
  assert.throws(() =>
    parseWindowInput({ start: '2024-01-01T02:00:00Z', end: '2024-01-01T00:00:00Z' })
  );
});

test('parseWindowInput rejects missing or invalid timestamps', () => {
  assert.throws(() => parseWindowInput({ start: 'not-a-date', end: '2024-01-01T02:00:00Z' }));
  assert.throws(() => parseWindowInput({ start: '2024-01-01T00:00:00Z' }));
});

test('computePause returns no pause when now is outside all windows', () => {
  const windows = [
    { start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' },
  ];
  const result = computePause(windows, new Date('2024-01-01T03:00:00Z'));
  assert.equal(result.paused, false);
});

test('computePause pauses when now falls inside a window', () => {
  const windows = [
    { start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' },
  ];
  const result = computePause(windows, new Date('2024-01-01T01:00:00Z'));
  assert.equal(result.paused, true);
  assert.equal(result.until.toISOString(), '2024-01-01T02:00:00.000Z');
});

test('computePause extends across overlapping windows', () => {
  const windows = [
    { start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' },
    { start: '2024-01-01T01:00:00Z', end: '2024-01-01T04:00:00Z' },
  ];
  const result = computePause(windows, new Date('2024-01-01T01:30:00Z'));
  assert.equal(result.paused, true);
  assert.equal(result.until.toISOString(), '2024-01-01T04:00:00.000Z');
});

test('computePause treats window boundaries as inclusive', () => {
  const windows = [
    { start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' },
  ];
  const atStart = computePause(windows, new Date('2024-01-01T00:00:00Z'));
  const atEnd = computePause(windows, new Date('2024-01-01T02:00:00Z'));
  assert.equal(atStart.paused, true);
  assert.equal(atEnd.paused, true);
});

test('computePause ignores windows that have already ended', () => {
  const windows = [
    { start: '2024-01-01T00:00:00Z', end: '2024-01-01T02:00:00Z' },
    { start: '2024-01-01T05:00:00Z', end: '2024-01-01T06:00:00Z' },
  ];
  const result = computePause(windows, new Date('2024-01-01T03:00:00Z'));
  assert.equal(result.paused, false);
});
