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
