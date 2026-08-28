import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheChartGeometry,
  concurrencyChartGeometry,
  contextChartGeometry,
  latencyChartGeometry,
  taskCacheNeedsRefresh,
  taskRevision,
  waterfallTimeline,
} from '../assets/dashboard-state.mjs';

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

test('dashboard chart geometry remains visible without measuring a rendered tab', () => {
  const latency = latencyChartGeometry([{
    durationMs: 1000,
    stageDurations: { receive: 100, reasoning: 300, tool: 200, commentary: 100, final: 100, other: 200 },
  }]);
  assert.ok(latency.rows[0].trackWidth > 0);
  assert.ok(latency.rows[0].segments.every((segment) => segment.width > 0));

  const concurrency = concurrencyChartGeometry([{ at: 1000, value: 1 }, { at: 2000, value: 1 }], 1);
  assert.match(concurrency.linePath, /^M /u);
  assert.ok(concurrency.points.every((point) => point.y < concurrency.baselineY));

  const cache = cacheChartGeometry([
    { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 20 },
  ]);
  assert.equal(cache.bars.length, 1, 'zero-token turns do not receive fabricated bars');
  assert.ok(cache.bars[0].segments.every((segment) => segment.height > 0));

  const context = contextChartGeometry([{ peakPercent: 72 }, { peakPercent: 90 }]);
  assert.ok(context.bars.every((bar) => bar.height > 0));
  assert.equal(context.bars[0].tone, 'warning');
  assert.equal(context.bars[1].tone, 'danger');
  assert.ok(context.dangerY < context.warningY);
});
