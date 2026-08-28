export function taskRevision(task) {
  const revision = Number(task?.revision);
  return Number.isFinite(revision) ? revision : null;
}

export function taskCacheNeedsRefresh(cacheEntry, task) {
  return Boolean(cacheEntry && task && cacheEntry.revision !== taskRevision(task));
}

export function waterfallTimeline(turn) {
  const stages = (turn?.stages ?? []).filter((stage) => Number.isFinite(stage.startedAtMs) && Number.isFinite(stage.completedAtMs));
  if (!stages.length) return null;
  const declaredStart = Number.isFinite(turn.receivedAtMs) ? turn.receivedAtMs : stages[0].startedAtMs;
  const declaredEnd = Number.isFinite(turn.durationMs) ? declaredStart + turn.durationMs : declaredStart;
  const start = Math.min(declaredStart, ...stages.map((stage) => stage.startedAtMs));
  const end = Math.max(declaredEnd, ...stages.map((stage) => stage.completedAtMs), start + 1);
  const durationMs = end - start;
  return {
    start,
    end,
    durationMs,
    stages: stages.map((stage) => {
      const left = Math.max(0, Math.min(100, (stage.startedAtMs - start) / durationMs * 100));
      const right = Math.max(left, Math.min(100, (stage.completedAtMs - start) / durationMs * 100));
      return { stage, left, width: Math.max(0.3, Math.min(100 - left, right - left)) };
    }),
  };
}

const LATENCY_KEYS = ['receive', 'reasoning', 'tool', 'commentary', 'final', 'other'];

export function latencyChartGeometry(entries, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 230;
  const labelWidth = options.labelWidth ?? 82;
  const plotWidth = width - labelWidth - 8;
  const rows = (entries ?? []).filter((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
  const maxDuration = Math.max(...rows.map((entry) => entry.durationMs), 1);
  const step = rows.length ? (height - 10) / rows.length : 0;
  return {
    width,
    height,
    labelWidth,
    rows: rows.map((entry, index) => {
      const y = 5 + index * step;
      const trackWidth = entry.durationMs / maxDuration * plotWidth;
      let x = labelWidth;
      const segments = LATENCY_KEYS.map((kind) => {
        const durationMs = Math.max(0, Number(entry.stageDurations?.[kind]) || 0);
        const segment = { kind, durationMs, x, width: durationMs / maxDuration * plotWidth };
        x += segment.width;
        return segment;
      });
      return { entry, y, barHeight: Math.max(2, Math.min(6, step - 1)), trackWidth, segments };
    }),
  };
}

export function concurrencyChartGeometry(entries, peakValue, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 230;
  const margin = { left: 34, right: 10, top: 12, bottom: 24 };
  const rows = (entries ?? []).filter((entry) => Number.isFinite(entry.at) && Number.isFinite(entry.value));
  const peak = Math.max(Number(peakValue) || 0, ...rows.map((entry) => entry.value), 1);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const start = rows[0]?.at ?? 0;
  const end = Math.max(rows.at(-1)?.at ?? start, start + 1);
  const xFor = (entry, index) => rows.length === 1
    ? margin.left + plotWidth / 2
    : margin.left + ((entry.at - start) / (end - start) || index / (rows.length - 1)) * plotWidth;
  const yFor = (value) => margin.top + (1 - Math.max(0, Math.min(peak, value)) / peak) * plotHeight;
  const points = rows.map((entry, index) => ({ entry, x: xFor(entry, index), y: yFor(entry.value) }));
  let linePath = '';
  for (const [index, point] of points.entries()) {
    if (index === 0) linePath = `M ${point.x} ${point.y}`;
    else linePath += ` H ${point.x} V ${point.y}`;
  }
  const baselineY = yFor(0);
  const areaPath = points.length ? `${linePath} L ${points.at(-1).x} ${baselineY} L ${points[0].x} ${baselineY} Z` : '';
  return { width, height, margin, peak, baselineY, peakY: yFor(peak), points, linePath, areaPath };
}

export function cacheChartGeometry(entries, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 230;
  const margin = { left: 8, right: 8, top: 12, bottom: 18 };
  const rows = (entries ?? []).map((entry) => {
    const input = Math.max(0, Number(entry.inputTokens) || 0);
    const cached = Math.min(input, Math.max(0, Number(entry.cachedInputTokens) || 0));
    const write = Math.max(0, Number(entry.cacheWriteInputTokens) || 0);
    return { entry, input, cached, uncached: input - cached, write, total: input + write };
  }).filter((entry) => entry.total > 0);
  const max = Math.max(...rows.map((entry) => entry.total), 1);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const slot = rows.length ? plotWidth / rows.length : plotWidth;
  const barWidth = Math.max(2, Math.min(16, slot * 0.72));
  const baselineY = margin.top + plotHeight;
  return {
    width,
    height,
    margin,
    max,
    baselineY,
    bars: rows.map((row, index) => {
      const x = margin.left + index * slot + (slot - barWidth) / 2;
      let bottom = baselineY;
      const segments = [
        ['uncached', row.uncached],
        ['cached', row.cached],
        ['write', row.write],
      ].map(([kind, value]) => {
        const segmentHeight = value / max * plotHeight;
        bottom -= segmentHeight;
        return { kind, value, x, y: bottom, width: barWidth, height: segmentHeight };
      });
      return { ...row, x, width: barWidth, segments };
    }),
  };
}

export function contextChartGeometry(entries, options = {}) {
  const width = options.width ?? 1000;
  const height = options.height ?? 230;
  const margin = { left: 34, right: 10, top: 12, bottom: 24 };
  const rows = (entries ?? []).filter((entry) => Number.isFinite(entry.peakPercent));
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const slot = rows.length ? plotWidth / rows.length : plotWidth;
  const barWidth = Math.max(2, Math.min(14, slot * 0.68));
  const yFor = (value) => margin.top + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const baselineY = yFor(0);
  const bars = rows.map((entry, index) => {
    const x = margin.left + index * slot + (slot - barWidth) / 2;
    const y = yFor(entry.peakPercent);
    return {
      entry,
      x,
      y,
      width: barWidth,
      height: baselineY - y,
      tone: entry.peakPercent >= 85 ? 'danger' : entry.peakPercent >= 70 ? 'warning' : 'healthy',
      pointX: x + barWidth / 2,
    };
  });
  const linePath = bars.map((bar, index) => `${index ? 'L' : 'M'} ${bar.pointX} ${bar.y}`).join(' ');
  return { width, height, margin, baselineY, warningY: yFor(70), dangerY: yFor(85), bars, linePath };
}
