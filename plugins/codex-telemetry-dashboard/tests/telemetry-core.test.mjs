import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TelemetryCollector, TelemetryStore, truncateUnicode } from '../scripts/telemetry-core.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const fixtures = join(testRoot, 'fixtures');

async function setupCodexHome() {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-test-'));
  const codexHome = join(root, '.codex');
  const sessions = join(codexHome, 'sessions', '2023', '11', '14');
  const archived = join(codexHome, 'archived_sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  await cp(join(fixtures, 'complete-turn.jsonl'), join(sessions, 'complete.jsonl'));
  await cp(join(fixtures, 'complete-turn.jsonl'), join(archived, 'duplicate.jsonl'));
  await cp(join(fixtures, 'aborted-turn.jsonl'), join(sessions, 'aborted.jsonl'));
  await cp(join(fixtures, 'analytics-turn.jsonl'), join(sessions, 'analytics.jsonl'));
  await writeFile(join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: 'thread-fixture', thread_name: '脱敏完整任务', updated_at: 1700000008 }),
    JSON.stringify({ id: 'thread-aborted', thread_name: '脱敏中止任务', updated_at: 1700002802 }),
    JSON.stringify({ id: 'thread-analytics', thread_name: '脱敏分析任务', updated_at: 1700000007 }),
  ].join('\n'));
  return { root, codexHome };
}

test('truncateUnicode keeps the full excerpt at or below the configured limit', () => {
  const result = truncateUnicode('测'.repeat(200), 160);
  assert.equal(Array.from(result).length, 160);
  assert.ok(result.endsWith('…'));
});

test('collector aggregates phases, token deltas, context, limits, and duplicate rollouts safely', async (t) => {
  const env = await setupCodexHome();
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const store = new TelemetryStore(':memory:');
  t.after(() => store.close());
  const collector = new TelemetryCollector(store, { codexHome: env.codexHome });
  await collector.scanAll();

  const turns = store.turnRows();
  assert.equal(turns.length, 3, 'duplicate rollout must not create another turn');
  const fixtureTask = store.taskList({ range: 'all' }).find((task) => task.threadId === 'thread-fixture');
  assert.ok(Number.isFinite(fixtureTask.revision), 'task list exposes a revision for selective detail refresh');
  const complete = turns.find((turn) => turn.turnId === 'turn-complete');
  assert.equal(complete.title, '脱敏完整任务');
  assert.equal(complete.status, 'completed');
  assert.equal(complete.durationMs, 8000);
  assert.equal(complete.ttftMs, 1000);
  assert.deepEqual(complete.tokens, {
    input: 250, cachedInput: 120, cacheWriteInput: 5, output: 50,
    reasoningOutput: 15, responseOutput: 35, total: 300,
  });
  assert.equal(complete.context.latest, 150);
  assert.equal(complete.context.peak, 150);
  assert.equal(complete.context.window, 1000);
  assert.equal(complete.context.compacted, true);
  assert.equal(complete.rateLimits.primary.used_percent, 11);
  assert.equal(complete.dimensions.executionMode, 'worktree');
  assert.equal(complete.dimensions.speed, 'standard');
  assert.equal(complete.toolSummary.calls, 1);
  assert.deepEqual(complete.stageDurations, { receive: 1000, reasoning: 1500, tool: 1500, commentary: 1000, final: 1000, other: 2000 });

  const aborted = turns.find((turn) => turn.turnId === 'turn-aborted');
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.durationMs, 2000);
  assert.equal(store.diagnosticRows()[0].event_type, 'future_event_type');

  const analytics = turns.find((turn) => turn.turnId === 'turn-analytics');
  assert.equal(analytics.dimensions.executionMode, 'automation');
  assert.equal(analytics.dimensions.automationKind, 'scheduled');
  assert.equal(analytics.toolSummary.calls, 3);
  assert.equal(analytics.toolSummary.failures, 1);
  const analyticsSummary = store.analytics({ range: 'all' });
  assert.equal(analyticsSummary.overview.completed, 2);
  assert.equal(analyticsSummary.overview.completionRate, 2 / 3);
  assert.equal(analyticsSummary.overview.contextDanger, 1);
  assert.equal(analyticsSummary.tools.calls, 4);
  assert.equal(analyticsSummary.tools.failures, 1);
  assert.equal(analyticsSummary.agents.count, 2);
  assert.equal(analyticsSummary.concurrency.peak, 2);
  assert.equal(analyticsSummary.coverage.workModes, true);
  assert.equal(analyticsSummary.workModes.automations[0].kind, 'scheduled');
  assert.equal(store.filteredTurns({ range: 'all', effort: 'medium' }).length, 1);
  assert.equal(store.filteredTurns({ range: 'all', mode: 'worktree' }).length, 1);
  assert.equal(store.taskTurns('thread-fixture', { range: 'all', mode: 'worktree' }).length, 1);
  assert.equal(store.taskTurns('thread-fixture', { range: 'all', mode: 'automation' }).length, 0);

  const serialized = JSON.stringify({ turns: store.turnRows(), stages: store.stageRows('turn-complete'), diagnostics: store.diagnosticRows() });
  const analyticsSerialized = JSON.stringify({ analytics: store.analytics({ range: 'all' }), stages: store.stageRows('turn-analytics') });
  for (const secret of ['PRIVATE_REASONING_MUST_NOT_PERSIST', 'SECRET_COMMAND_MUST_NOT_PERSIST', 'SECRET_OUTPUT_MUST_NOT_PERSIST', 'UNKNOWN_CONTENT_MUST_NOT_PERSIST']) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into normalized data`);
  }
  for (const secret of ['SECRET_ARGUMENT_MUST_NOT_PERSIST', 'SECRET_MCP_OUTPUT_MUST_NOT_PERSIST', 'SECRET_AGENT_ERROR_MUST_NOT_PERSIST', 'RAW_AGENT_ONE_MUST_NOT_PERSIST', 'RAW_AGENT_TWO_MUST_NOT_PERSIST', 'RAW_PARENT_AGENT_MUST_NOT_PERSIST']) {
    assert.equal(analyticsSerialized.includes(secret), false, `${secret} leaked into analytics data`);
  }
});

test('history clear keeps active collection state and explicit reimport restores completed metrics', async (t) => {
  const env = await setupCodexHome();
  t.after(() => rm(env.root, { recursive: true, force: true }));
  const store = new TelemetryStore(':memory:');
  t.after(() => store.close());
  const collector = new TelemetryCollector(store, { codexHome: env.codexHome });
  await collector.scanAll();
  assert.equal(store.turnRows().length, 3);
  assert.equal(store.clearHistory(), 3);
  assert.equal(store.turnRows().length, 0);
  store.resetForReimport();
  await collector.scanAll();
  assert.equal(store.turnRows().length, 3);
});

test('schema v2 rebuild preserves the user history cutoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-schema-'));
  const databasePath = join(root, 'metrics.sqlite');
  const first = new TelemetryStore(databasePath);
  first.setSetting('schema_version', '1');
  first.setSetting('import_cutoff_ms', '1700000000123');
  first.ensureTurn({ turnId: 'legacy-turn', threadId: 'legacy-thread', receivedAtMs: 1700000000000 });
  first.close();

  const migrated = new TelemetryStore(databasePath);
  t.after(async () => {
    migrated.close();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (error.code !== 'EBUSY' || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }
  });
  assert.equal(migrated.getSetting('schema_version'), '2');
  assert.equal(migrated.getSetting('import_cutoff_ms'), '1700000000123');
  assert.equal(migrated.turnRows().length, 0);
  assert.equal(migrated.sourceCount(), 0);
});
