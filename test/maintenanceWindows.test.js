import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store.js';
import {
  MAX_WINDOWS,
  MAX_WINDOW_MS,
  MAX_REASON_LENGTH,
  MaintenanceWindowError,
  parseWindowInput,
  computePause,
  listWindows,
  listUpcomingWindows,
  addWindow,
  removeWindow,
  getDispatchPause,
  describePause,
} from '../src/maintenanceWindows.js';

const BASE_NOW = Date.parse('2026-06-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

test('parseWindowInput accepts ISO-8601 strings and epoch ms and normalizes reason', () => {
  const fromEpoch = parseWindowInput(
    { startsAt: BASE_NOW - HOUR_MS, endsAt: BASE_NOW + 2 * HOUR_MS, reason: '  contract upgrade  ' },
    BASE_NOW,
  );
  assert.deepEqual(fromEpoch, {
    startsAt: BASE_NOW - HOUR_MS,
    endsAt: BASE_NOW + 2 * HOUR_MS,
    reason: 'contract upgrade',
  });

  const fromIso = parseWindowInput(
    {
      startsAt: new Date(BASE_NOW + HOUR_MS).toISOString(),
      endsAt: new Date(BASE_NOW + 3 * HOUR_MS).toISOString(),
      reason: '   ',
    },
    BASE_NOW,
  );
  assert.deepEqual(fromIso, {
    startsAt: BASE_NOW + HOUR_MS,
    endsAt: BASE_NOW + 3 * HOUR_MS,
    reason: null,
  });
});

test('parseWindowInput rejects missing, inverted, past, oversized, or invalid-reason inputs', () => {
  assert.throws(() => parseWindowInput({}, BASE_NOW), MaintenanceWindowError);
  assert.throws(
    () => parseWindowInput({ startsAt: 'not-a-date', endsAt: BASE_NOW + HOUR_MS }, BASE_NOW),
    /startsAt and endsAt are required/,
  );
  assert.throws(
    () => parseWindowInput({ startsAt: BASE_NOW + HOUR_MS, endsAt: BASE_NOW + HOUR_MS }, BASE_NOW),
    /endsAt must be after startsAt/,
  );
  assert.throws(
    () => parseWindowInput({ startsAt: BASE_NOW - 2 * HOUR_MS, endsAt: BASE_NOW }, BASE_NOW),
    /endsAt is already in the past/,
  );
  assert.throws(
    () => parseWindowInput({ startsAt: BASE_NOW, endsAt: BASE_NOW + MAX_WINDOW_MS + 1 }, BASE_NOW),
    /at most 31 days long/,
  );
  assert.throws(
    () => parseWindowInput({ startsAt: BASE_NOW, endsAt: BASE_NOW + HOUR_MS, reason: 123 }, BASE_NOW),
    /reason must be a string/,
  );
  assert.throws(
    () =>
      parseWindowInput(
        { startsAt: BASE_NOW, endsAt: BASE_NOW + HOUR_MS, reason: 'x'.repeat(MAX_REASON_LENGTH + 1) },
        BASE_NOW,
      ),
    /reason must be at most/,
  );
});

test('computePause merges overlapping and touching windows in a single pass and ignores disjoint future windows', () => {
  assert.equal(computePause([], BASE_NOW), null);

  // Only future or already-ended windows -> null
  assert.equal(
    computePause(
      [
        { id: 'past', startsAt: BASE_NOW - 3 * HOUR_MS, endsAt: BASE_NOW, reason: 'done' },
        { id: 'future', startsAt: BASE_NOW + HOUR_MS, endsAt: BASE_NOW + 2 * HOUR_MS, reason: 'later' },
      ],
      BASE_NOW,
    ),
    null,
  );

  // Multi-hop chain provided in reverse order: active [now-1h, now+1h] touches [now+1h, now+2h]
  // which overlaps [now+1.5h, now+4h], while [now+5h, now+6h] is disjoint and excluded.
  const windows = [
    { id: 'w-disjoint', startsAt: BASE_NOW + 5 * HOUR_MS, endsAt: BASE_NOW + 6 * HOUR_MS, reason: 'separate' },
    { id: 'w-hop-2', startsAt: BASE_NOW + 1.5 * HOUR_MS, endsAt: BASE_NOW + 4 * HOUR_MS, reason: 'hop2' },
    { id: 'w-hop-1', startsAt: BASE_NOW + HOUR_MS, endsAt: BASE_NOW + 2 * HOUR_MS, reason: 'hop1' },
    { id: 'w-active-late', startsAt: BASE_NOW - 0.5 * HOUR_MS, endsAt: BASE_NOW + 0.5 * HOUR_MS, reason: 'late' },
    { id: 'w-active-early', startsAt: BASE_NOW - HOUR_MS, endsAt: BASE_NOW + HOUR_MS, reason: 'primary reason' },
  ];

  const pause = computePause(windows, BASE_NOW);
  assert.deepEqual(pause, {
    windowId: 'w-active-early',
    reason: 'primary reason',
    startsAt: BASE_NOW - HOUR_MS,
    resumesAt: BASE_NOW + 4 * HOUR_MS,
  });

  assert.match(
    describePause(pause),
    /dispatch is paused for scheduled maintenance \(primary reason\) until 2026-06-15T16:00:00\.000Z/,
  );
});

test('addWindow, listWindows, listUpcomingWindows, removeWindow, and getDispatchPause manage store state and prune expired windows', async () => {
  const prev = await store.get('dispatch-pause-windows');
  try {
    // Seed an expired window older than 7 days to verify addWindow prunes it
    await store.set('dispatch-pause-windows', [
      {
        id: 'mw_expired_old',
        startsAt: BASE_NOW - 10 * DAY_MS,
        endsAt: BASE_NOW - 8 * DAY_MS,
        reason: 'ancient',
        createdAt: BASE_NOW - 10 * DAY_MS,
        createdBy: 'admin',
      },
    ]);

    const activeWin = await addWindow(
      { startsAt: BASE_NOW - HOUR_MS, endsAt: BASE_NOW + HOUR_MS, reason: 'migration' },
      { createdBy: 'ops', now: BASE_NOW },
    );
    const futureWin = await addWindow(
      { startsAt: BASE_NOW + 2 * HOUR_MS, endsAt: BASE_NOW + 3 * HOUR_MS, reason: 'followup' },
      { createdBy: 'ops', now: BASE_NOW },
    );

    const all = await listWindows();
    assert.deepEqual(
      all.map((w) => w.id),
      [activeWin.id, futureWin.id],
    );

    const upcomingAtPlus90m = await listUpcomingWindows(BASE_NOW + 1.5 * HOUR_MS);
    assert.deepEqual(
      upcomingAtPlus90m.map((w) => w.id),
      [futureWin.id],
    );

    const livePause = await getDispatchPause(BASE_NOW);
    assert.equal(livePause.windowId, activeWin.id);
    assert.equal(livePause.resumesAt, BASE_NOW + HOUR_MS);

    assert.equal(await removeWindow('mw_nonexistent', BASE_NOW), false);
    assert.equal(await removeWindow(activeWin.id, BASE_NOW), true);
    assert.equal(await getDispatchPause(BASE_NOW), null);

    // Enforce MAX_WINDOWS cap
    const many = Array.from({ length: MAX_WINDOWS }, (_, i) => ({
      id: `mw_${i}`,
      startsAt: BASE_NOW + (i + 1) * HOUR_MS,
      endsAt: BASE_NOW + (i + 2) * HOUR_MS,
      reason: null,
      createdAt: BASE_NOW,
      createdBy: 'admin',
    }));
    await store.set('dispatch-pause-windows', many);
    await assert.rejects(
      () => addWindow({ startsAt: BASE_NOW, endsAt: BASE_NOW + HOUR_MS }, { now: BASE_NOW }),
      /at most 100 maintenance windows/,
    );
  } finally {
    if (prev === null) await store.delete('dispatch-pause-windows');
    else await store.set('dispatch-pause-windows', prev);
  }
});
