import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCacheNeedsRefresh, taskRevision, waterfallTimeline } from '../assets/dashboard-state.mjs';

test('task cache refreshes only when the expanded task revision changes', () => {
  const cached = { revision: 10, turns: [{ turnId: 'turn-1' }] };
  assert.equal(taskRevision({ revision: 10 }), 10);
  assert.equal(taskCacheNeedsRefresh(cached, { revision: 10 }), false);
  assert.equal(taskCacheNeedsRefresh(cached, { revision: 11 }), true);
  assert.equal(taskCacheNeedsRefresh(null, { revision: 11 }), false);
});

test('waterfall stages retain their relative horizontal offsets and widths', () => {
  const timeline = waterfallTimeline({
    receivedAtMs: 1000,
    durationMs: 1000,
    stages: [
      { kind: 'reasoning', startedAtMs: 1100, completedAtMs: 1300 },
      { kind: 'tool', startedAtMs: 1500, completedAtMs: 1800 },
    ],
  });
  assert.equal(timeline.durationMs, 1000);
  assert.deepEqual(timeline.stages.map(({ left, width }) => [left, width]), [[10, 20], [50, 30]]);
});
