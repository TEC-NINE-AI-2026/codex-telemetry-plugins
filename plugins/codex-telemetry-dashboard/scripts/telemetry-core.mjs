import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const KNOWN_PAYLOAD_TYPES = new Set([
  'task_started', 'task_complete', 'turn_aborted', 'item_completed', 'token_count',
  'thread_settings_applied', 'message', 'reasoning', 'custom_tool_call',
  'custom_tool_call_output', 'function_call', 'function_call_output', 'agent_message',
  'user_message',
]);

const TOOL_ITEM_TYPES = new Set([
  'CommandExecution', 'McpToolCall', 'Extension', 'DynamicToolCall',
  'CollabAgentToolCall', 'FileChange', 'ImageView', 'SubAgentActivity',
  'ComputerUse', 'ComputerToolCall', 'FileSearch', 'WebSearch', 'CodeInterpreter',
  'ApplyPatch',
]);

const SUCCESS_STATUSES = new Set(['completed', 'success', 'succeeded', 'ok']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'error']);
const ABORTED_STATUSES = new Set(['aborted']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);
const EXECUTION_MODES = new Set(['local', 'worktree', 'cloud', 'handoff', 'background', 'automation']);

function numberOrNull(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncateUnicode(value, limit = 160) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  const points = Array.from(normalized);
  return points.length <= limit ? normalized : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

export function extractMessageExcerpt(content, limit = 160) {
  const fragments = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      fragments.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') fragments.push(value.text);
      else if (typeof value.content === 'string') fragments.push(value.content);
    }
  };
  visit(content);
  return truncateUnicode(fragments.join(' '), limit);
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stableId(parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

function safeLabel(value, limit = 100) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit || !/^[\p{L}\p{N}_.:/@+-]+$/u.test(trimmed)) return null;
  return trimmed;
}

function firstSafeLabel(values, limit = 100) {
  for (const value of values) {
    const label = safeLabel(value, limit);
    if (label) return label;
  }
  return null;
}

function normalizeToolStatus(value) {
  const status = safeLabel(value, 32)?.toLowerCase();
  if (!status) return 'unknown';
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (FAILURE_STATUSES.has(status)) return 'failure';
  if (ABORTED_STATUSES.has(status)) return 'aborted';
  if (CANCELLED_STATUSES.has(status)) return 'cancelled';
  return 'unknown';
}

function normalizeExecutionMode(value) {
  const mode = safeLabel(value, 32)?.toLowerCase();
  return EXECUTION_MODES.has(mode) ? mode : null;
}

function extractDimensions(payload = {}) {
  const environment = payload.environment && typeof payload.environment === 'object' ? payload.environment : {};
  const automation = payload.automation && typeof payload.automation === 'object' ? payload.automation : {};
  const dimensions = {
    speed: firstSafeLabel([payload.speed, payload.service_tier], 40),
    reasoningMode: firstSafeLabel([payload.reasoning_mode, payload.reasoning?.mode], 40),
    reasoningContext: firstSafeLabel([payload.reasoning_context, payload.reasoning?.context], 40),
    executionMode: normalizeExecutionMode(payload.execution_mode ?? payload.work_mode ?? environment.type),
    origin: firstSafeLabel([payload.originator, payload.origin, typeof payload.source === 'string' ? payload.source : null], 80),
    automationKind: firstSafeLabel([payload.automation_kind, automation.kind], 80),
  };
  if (!dimensions.executionMode && dimensions.automationKind) dimensions.executionMode = 'automation';
  return Object.fromEntries(Object.entries(dimensions).filter(([, value]) => value !== null));
}

function toolCategory(type) {
  if (type === 'CommandExecution') return 'shell';
  if (type === 'McpToolCall') return 'mcp';
  if (type === 'Extension' || type === 'DynamicToolCall') return 'plugin';
  if (type === 'FileChange' || type === 'ApplyPatch') return 'file-change';
  if (type === 'ImageView') return 'image';
  if (type === 'ComputerUse' || type === 'ComputerToolCall') return 'computer-use';
  if (type === 'CollabAgentToolCall' || type === 'SubAgentActivity') return 'sub-agent';
  if (type === 'FileSearch') return 'file-search';
  if (type === 'WebSearch') return 'web-search';
  if (type === 'CodeInterpreter') return 'code-interpreter';
  return 'unknown';
}

function extractToolMetadata(item = {}) {
  if (!TOOL_ITEM_TYPES.has(item.type)) return {};
  const category = toolCategory(item.type);
  const server = firstSafeLabel([item.server, item.server_name, item.mcp_server], 80);
  const explicitName = firstSafeLabel([item.tool, item.tool_name, item.name, item.action], 100);
  const defaults = {
    shell: 'Shell', mcp: 'MCP', plugin: 'Plugin', 'file-change': 'File change', image: 'Image view',
    'computer-use': 'Computer Use', 'sub-agent': 'Sub-agent', 'file-search': 'File search',
    'web-search': 'Web search', 'code-interpreter': 'Code interpreter', unknown: 'Unknown tool',
  };
  const rawAgentId = firstSafeLabel([
    item.agent_id, item.agentId, item.subagent_id, item.sub_agent_id, item.receiver_agent_id, item.agent?.id,
  ], 160);
  const rawParentAgentId = firstSafeLabel([
    item.parent_agent_id, item.parentAgentId, item.sender_agent_id, item.parent?.id,
  ], 160);
  return {
    toolCategory: category,
    toolName: server && explicitName ? `${server}/${explicitName}` : explicitName || defaults[category],
    toolStatus: normalizeToolStatus(item.status),
    agentId: rawAgentId ? stableId(['agent', rawAgentId]).slice(0, 16) : null,
    parentAgentId: rawParentAgentId ? stableId(['agent', rawParentAgentId]).slice(0, 16) : null,
  };
}

function walkJsonl(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files;
}

function classifyItem(item) {
  if (!item) return 'other';
  if (item.type === 'UserMessage') return 'input';
  if (item.type === 'Reasoning') return 'reasoning';
  if (item.type === 'AgentMessage') return item.phase === 'final_answer' ? 'final' : 'commentary';
  if (item.type === 'ContextCompaction') return 'compaction';
  if (TOOL_ITEM_TYPES.has(item.type)) return 'tool';
  return 'other';
}

function allocateDurations(turn, stages, now = Date.now()) {
  const start = turn.receivedAtMs;
  const total = Math.max(0, turn.durationMs ?? (start ? now - start : 0));
  const end = start ? start + total : null;
  const intervals = [];
  if (start && turn.ttftMs !== null && turn.ttftMs !== undefined) {
    intervals.push({ kind: 'receive', start, end: Math.min(end ?? start + turn.ttftMs, start + turn.ttftMs) });
  }
  for (const stage of stages) {
    if (!['reasoning', 'tool', 'commentary', 'final'].includes(stage.kind)) continue;
    if (!stage.startedAtMs || !stage.completedAtMs) continue;
    const left = start ? Math.max(start, stage.startedAtMs) : stage.startedAtMs;
    const right = end ? Math.min(end, stage.completedAtMs) : stage.completedAtMs;
    if (right > left) intervals.push({ kind: stage.kind, start: left, end: right });
  }
  if (!intervals.length) return { receive: 0, reasoning: 0, tool: 0, commentary: 0, final: 0, other: total };
  const boundaries = [...new Set(intervals.flatMap((entry) => [entry.start, entry.end]))].sort((a, b) => a - b);
  const result = { receive: 0, reasoning: 0, tool: 0, commentary: 0, final: 0, other: 0 };
  const priority = ['final', 'commentary', 'tool', 'reasoning', 'receive'];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const left = boundaries[index];
    const right = boundaries[index + 1];
    const active = intervals.filter((entry) => entry.start < right && entry.end > left).map((entry) => entry.kind);
    const selected = priority.find((kind) => active.includes(kind));
    if (selected) result[selected] += right - left;
  }
  const allocated = result.receive + result.reasoning + result.tool + result.commentary + result.final;
  result.other = Math.max(0, total - allocated);
  for (const key of Object.keys(result)) result[key] = Math.round(result[key]);
  return result;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function concurrencyMetrics(turns, now = Date.now()) {
  const intervals = turns.filter((turn) => turn.receivedAtMs && (turn.completedAtMs || turn.durationMs !== null)).map((turn) => ({
    id: turn.turnId,
    start: turn.receivedAtMs,
    end: turn.completedAtMs ?? (turn.receivedAtMs + (turn.durationMs ?? Math.max(0, now - turn.receivedAtMs))),
  })).filter((entry) => entry.end > entry.start);
  const events = intervals.flatMap((entry) => [
    { at: entry.start, delta: 1, id: entry.id },
    { at: entry.end, delta: -1, id: entry.id },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  const active = new Set();
  const overlapped = new Set();
  const timeline = [];
  let peak = 0;
  for (const event of events) {
    if (event.delta < 0) active.delete(event.id);
    else {
      if (active.size) {
        overlapped.add(event.id);
        for (const id of active) overlapped.add(id);
      }
      active.add(event.id);
    }
    peak = Math.max(peak, active.size);
    if (timeline.at(-1)?.at === event.at) timeline.at(-1).value = active.size;
    else timeline.push({ at: event.at, value: active.size });
  }
  const sampled = timeline.length <= 240 ? timeline : timeline.filter((_, index) => index % Math.ceil(timeline.length / 240) === 0 || index === timeline.length - 1);
  return {
    peak,
    current: turns.filter((turn) => turn.status === 'running').length,
    overlappingTurns: overlapped.size,
    parallelTurnPercent: ratio(overlapped.size, intervals.length),
    timeline: sampled,
  };
}

function intervalOverlapMetrics(stages) {
  const intervals = stages.filter((stage) => stage.startedAtMs && stage.completedAtMs && stage.completedAtMs > stage.startedAtMs);
  if (!intervals.length) return { combinedDurationMs: 0, wallClockMs: null, overlapPercent: null };
  const combinedDurationMs = intervals.reduce((sum, stage) => sum + (stage.durationMs ?? stage.completedAtMs - stage.startedAtMs), 0);
  const wallClockMs = Math.max(...intervals.map((stage) => stage.completedAtMs)) - Math.min(...intervals.map((stage) => stage.startedAtMs));
  return { combinedDurationMs, wallClockMs, overlapPercent: ratio(Math.max(0, combinedDurationMs - wallClockMs), combinedDurationMs) };
}

export class TelemetryStore {
  constructor(databasePath = ':memory:') {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT,
        title TEXT,
        cwd TEXT,
        source_path TEXT,
        dimensions_json TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        received_at_ms INTEGER,
        user_sent_at_ms INTEGER,
        completed_at_ms INTEGER,
        duration_ms INTEGER,
        ttft_ms INTEGER,
        model TEXT,
        effort TEXT,
        user_excerpt TEXT,
        assistant_excerpt TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_latest INTEGER,
        context_peak INTEGER,
        context_window INTEGER,
        compacted INTEGER NOT NULL DEFAULT 0,
        rate_limits_json TEXT,
        dimensions_json TEXT,
        source_path TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_thread_time ON turns(thread_id, received_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_time ON turns(received_at_ms DESC);
      CREATE TABLE IF NOT EXISTS stages (
        stage_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        raw_type TEXT NOT NULL,
        status TEXT,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        duration_ms INTEGER,
        metadata_json TEXT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stages_turn_time ON stages(turn_id, started_at_ms);
      CREATE TABLE IF NOT EXISTS usage_events (
        usage_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_input INTEGER,
        context_window INTEGER,
        rate_limits_json TEXT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_usage_turn_time ON usage_events(turn_id, timestamp_ms);
      CREATE TABLE IF NOT EXISTS source_files (
        source_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        partial_line TEXT NOT NULL DEFAULT '',
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT,
        session_id TEXT,
        current_turn_id TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        event_type TEXT PRIMARY KEY,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_seen_ms INTEGER NOT NULL
      );
    `);
    const previousVersion = numberOrNull(this.getSetting('schema_version')) ?? 0;
    const threadColumns = new Set(this.db.prepare('PRAGMA table_info(threads)').all().map((row) => row.name));
    const turnColumns = new Set(this.db.prepare('PRAGMA table_info(turns)').all().map((row) => row.name));
    if (!threadColumns.has('dimensions_json')) this.db.exec('ALTER TABLE threads ADD COLUMN dimensions_json TEXT;');
    if (!turnColumns.has('dimensions_json')) this.db.exec('ALTER TABLE turns ADD COLUMN dimensions_json TEXT;');
    if (previousVersion > 0 && previousVersion < 2) {
      this.db.exec('DELETE FROM stages; DELETE FROM usage_events; DELETE FROM turns; DELETE FROM threads; DELETE FROM source_files; DELETE FROM diagnostics;');
      this.setSetting('session_index_mtime_ms', '0');
    }
    this.setSetting('schema_version', '2');
    if (this.getSetting('import_cutoff_ms') === null) this.setSetting('import_cutoff_ms', '0');
    const clearKnownDiagnostic = this.db.prepare('DELETE FROM diagnostics WHERE event_type=?');
    for (const knownType of KNOWN_PAYLOAD_TYPES) clearKnownDiagnostic.run(knownType);
  }

  close() { this.db.close(); }
  getSetting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }

  getSource(sourcePath) {
    return this.db.prepare('SELECT * FROM source_files WHERE source_path = ?').get(sourcePath) ?? null;
  }

  saveSource(source) {
    this.db.prepare(`
      INSERT INTO source_files(source_path,byte_offset,partial_line,file_size,mtime_ms,thread_id,session_id,current_turn_id,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_path) DO UPDATE SET
        byte_offset=excluded.byte_offset, partial_line=excluded.partial_line, file_size=excluded.file_size,
        mtime_ms=excluded.mtime_ms, thread_id=excluded.thread_id, session_id=excluded.session_id,
        current_turn_id=excluded.current_turn_id, updated_at_ms=excluded.updated_at_ms
    `).run(source.sourcePath, source.byteOffset, source.partialLine ?? '', source.fileSize ?? 0,
      source.mtimeMs ?? 0, source.threadId, source.sessionId, source.currentTurnId, Date.now());
  }

  upsertThread({ threadId, sessionId = null, title = null, cwd = null, sourcePath = null, dimensions = null, createdAtMs = null }) {
    if (!threadId) return;
    const existingDimensions = parseJson(this.db.prepare('SELECT dimensions_json FROM threads WHERE thread_id=?').get(threadId)?.dimensions_json, {});
    const mergedDimensions = { ...existingDimensions, ...Object.fromEntries(Object.entries(dimensions ?? {}).filter(([, value]) => value !== null && value !== undefined)) };
    this.db.prepare(`
      INSERT INTO threads(thread_id,session_id,title,cwd,source_path,dimensions_json,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET
        session_id=COALESCE(excluded.session_id,threads.session_id),
        title=COALESCE(excluded.title,threads.title),
        cwd=COALESCE(excluded.cwd,threads.cwd),
        source_path=COALESCE(excluded.source_path,threads.source_path),
        dimensions_json=COALESCE(excluded.dimensions_json,threads.dimensions_json),
        created_at_ms=COALESCE(threads.created_at_ms,excluded.created_at_ms),
        updated_at_ms=excluded.updated_at_ms
    `).run(threadId, sessionId, title, cwd, sourcePath,
      Object.keys(mergedDimensions).length ? safeJson(mergedDimensions) : null, createdAtMs, Date.now());
  }

  ensureTurn({ turnId, threadId, sourcePath = null, receivedAtMs = null, status = 'running' }) {
    if (!turnId || !threadId) return;
    this.upsertThread({ threadId, sourcePath });
    this.db.prepare(`
      INSERT INTO turns(turn_id,thread_id,status,received_at_ms,source_path,updated_at_ms)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(turn_id) DO UPDATE SET
        thread_id=excluded.thread_id,
        status=CASE WHEN turns.status IN ('completed','aborted') THEN turns.status ELSE excluded.status END,
        received_at_ms=COALESCE(turns.received_at_ms,excluded.received_at_ms),
        source_path=COALESCE(turns.source_path,excluded.source_path),
        updated_at_ms=excluded.updated_at_ms
    `).run(turnId, threadId, status, receivedAtMs, sourcePath, Date.now());
  }

  updateTurn(turnId, fields) {
    const allowed = new Map([
      ['status', 'status'], ['receivedAtMs', 'received_at_ms'], ['userSentAtMs', 'user_sent_at_ms'],
      ['completedAtMs', 'completed_at_ms'], ['durationMs', 'duration_ms'], ['ttftMs', 'ttft_ms'],
      ['model', 'model'], ['effort', 'effort'], ['userExcerpt', 'user_excerpt'],
      ['assistantExcerpt', 'assistant_excerpt'], ['compacted', 'compacted'],
    ]);
    const entries = Object.entries(fields).filter(([key, value]) => allowed.has(key) && value !== undefined);
    if (fields.dimensions) {
      const existing = parseJson(this.db.prepare('SELECT dimensions_json FROM turns WHERE turn_id=?').get(turnId)?.dimensions_json, {});
      const merged = { ...existing, ...Object.fromEntries(Object.entries(fields.dimensions).filter(([, value]) => value !== null && value !== undefined)) };
      if (Object.keys(merged).length) {
        this.db.prepare('UPDATE turns SET dimensions_json=?,updated_at_ms=? WHERE turn_id=?').run(safeJson(merged), Date.now(), turnId);
      }
    }
    if (!entries.length) return;
    const assignments = entries.map(([key]) => `${allowed.get(key)} = ?`);
    const values = entries.map(([, value]) => value);
    assignments.push('updated_at_ms = ?');
    values.push(Date.now(), turnId);
    this.db.prepare(`UPDATE turns SET ${assignments.join(', ')} WHERE turn_id = ?`).run(...values);
  }

  markIncomplete(turnId) {
    this.db.prepare("UPDATE turns SET status='incomplete', updated_at_ms=? WHERE turn_id=? AND status='running'").run(Date.now(), turnId);
  }

  addStage(turnId, item, startedAtMs, completedAtMs) {
    const kind = classifyItem(item);
    const stageId = stableId([turnId, item?.id, item?.type, item?.phase, startedAtMs, completedAtMs]);
    const metadata = safeJson({ phase: item?.phase ?? null, rawType: item?.type ?? 'Unknown', ...extractToolMetadata(item) });
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO stages(stage_id,turn_id,kind,raw_type,status,started_at_ms,completed_at_ms,duration_ms,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(stageId, turnId, kind, item?.type ?? 'Unknown', item?.status ?? 'completed', startedAtMs,
      completedAtMs, startedAtMs !== null && completedAtMs !== null ? Math.max(0, completedAtMs - startedAtMs) : null, metadata);
    if (kind === 'compaction') this.updateTurn(turnId, { compacted: 1 });
    return result.changes > 0;
  }

  addUsage(turnId, timestampMs, info, rateLimits) {
    const usage = info?.last_token_usage;
    if (!usage) return false;
    const input = numberOrNull(usage.input_tokens) ?? 0;
    const cached = numberOrNull(usage.cached_input_tokens) ?? 0;
    const cacheWrite = numberOrNull(usage.cache_write_input_tokens) ?? 0;
    const output = numberOrNull(usage.output_tokens) ?? 0;
    const reasoning = numberOrNull(usage.reasoning_output_tokens) ?? 0;
    const total = numberOrNull(usage.total_tokens) ?? input + output;
    const contextWindow = numberOrNull(info?.model_context_window);
    const usageId = stableId([turnId, timestampMs, input, cached, cacheWrite, output, reasoning, total]);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events(
        usage_id,turn_id,timestamp_ms,input_tokens,cached_input_tokens,cache_write_input_tokens,
        output_tokens,reasoning_output_tokens,total_tokens,context_input,context_window,rate_limits_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(usageId, turnId, timestampMs ?? Date.now(), input, cached, cacheWrite, output, reasoning, total,
      input, contextWindow, safeJson(rateLimits));
    if (result.changes > 0) this.refreshTurnUsage(turnId);
    return result.changes > 0;
  }

  refreshTurnUsage(turnId) {
    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(input_tokens),0) input_tokens,
        COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens),0) cache_write_input_tokens,
        COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(reasoning_output_tokens),0) reasoning_output_tokens,
        COALESCE(SUM(total_tokens),0) total_tokens,
        MAX(context_input) context_peak
      FROM usage_events WHERE turn_id=?
    `).get(turnId);
    const latest = this.db.prepare(`
      SELECT context_input,context_window,rate_limits_json FROM usage_events
      WHERE turn_id=? ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1
    `).get(turnId) ?? {};
    this.db.prepare(`
      UPDATE turns SET input_tokens=?,cached_input_tokens=?,cache_write_input_tokens=?,output_tokens=?,
        reasoning_output_tokens=?,total_tokens=?,context_latest=?,context_peak=?,context_window=?,
        rate_limits_json=COALESCE(?,rate_limits_json),updated_at_ms=? WHERE turn_id=?
    `).run(totals.input_tokens, totals.cached_input_tokens, totals.cache_write_input_tokens,
      totals.output_tokens, totals.reasoning_output_tokens, totals.total_tokens,
      latest.context_input ?? null, totals.context_peak ?? null, latest.context_window ?? null,
      latest.rate_limits_json ?? null, Date.now(), turnId);
  }

  recordDiagnostic(eventType, timestampMs = Date.now()) {
    this.db.prepare(`
      INSERT INTO diagnostics(event_type,event_count,last_seen_ms) VALUES(?,1,?)
      ON CONFLICT(event_type) DO UPDATE SET event_count=diagnostics.event_count+1,last_seen_ms=excluded.last_seen_ms
    `).run(eventType || 'unknown', timestampMs);
  }

  resetForReimport() {
    this.db.exec('DELETE FROM stages; DELETE FROM usage_events; DELETE FROM turns; DELETE FROM threads; DELETE FROM source_files; DELETE FROM diagnostics;');
    this.setSetting('import_cutoff_ms', '0');
  }

  clearHistory() {
    const completedIds = this.db.prepare("SELECT turn_id FROM turns WHERE status <> 'running'").all().map((row) => row.turn_id);
    const removeStage = this.db.prepare('DELETE FROM stages WHERE turn_id=?');
    const removeUsage = this.db.prepare('DELETE FROM usage_events WHERE turn_id=?');
    const removeTurn = this.db.prepare('DELETE FROM turns WHERE turn_id=?');
    this.db.exec('BEGIN');
    try {
      for (const id of completedIds) { removeStage.run(id); removeUsage.run(id); removeTurn.run(id); }
      this.db.exec('DELETE FROM threads WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM turns)');
      this.setSetting('import_cutoff_ms', String(Date.now()));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return completedIds.length;
  }

  sourceCount() { return this.db.prepare('SELECT COUNT(*) count FROM source_files').get().count; }
  diagnosticRows() { return this.db.prepare('SELECT * FROM diagnostics ORDER BY event_count DESC').all(); }

  stageRows(turnId) {
    return this.db.prepare('SELECT * FROM stages WHERE turn_id=? ORDER BY started_at_ms,completed_at_ms').all(turnId).map((row) => ({
      stageId: row.stage_id, kind: row.kind, rawType: row.raw_type, status: row.status,
      startedAtMs: row.started_at_ms, completedAtMs: row.completed_at_ms, durationMs: row.duration_ms,
      metadata: parseJson(row.metadata_json, {}),
    }));
  }

  usageRows(turnId) {
    return this.db.prepare('SELECT * FROM usage_events WHERE turn_id=? ORDER BY timestamp_ms').all(turnId).map((row) => ({
      timestampMs: row.timestamp_ms,
      tokens: {
        input: row.input_tokens, cachedInput: row.cached_input_tokens, cacheWriteInput: row.cache_write_input_tokens,
        output: row.output_tokens, reasoningOutput: row.reasoning_output_tokens, total: row.total_tokens,
      },
      context: { input: row.context_input, window: row.context_window },
      rateLimits: parseJson(row.rate_limits_json),
    }));
  }

  turnRows() {
    return this.db.prepare(`
      SELECT t.*, th.title, th.cwd, th.session_id, th.dimensions_json AS thread_dimensions_json FROM turns t
      LEFT JOIN threads th ON th.thread_id=t.thread_id ORDER BY t.received_at_ms DESC
    `).all().map((row) => this.mapTurn(row));
  }

  mapTurn(row, includeDetails = false) {
    const dimensions = { ...parseJson(row.thread_dimensions_json, {}), ...parseJson(row.dimensions_json, {}) };
    const turn = {
      turnId: row.turn_id, threadId: row.thread_id, sessionId: row.session_id,
      title: row.title || '未命名任务', cwd: row.cwd, project: row.cwd ? basename(row.cwd) : '未知项目',
      status: row.status, receivedAtMs: row.received_at_ms, userSentAtMs: row.user_sent_at_ms,
      updatedAtMs: row.updated_at_ms,
      completedAtMs: row.completed_at_ms, durationMs: row.duration_ms, ttftMs: row.ttft_ms,
      model: row.model || '未知模型', effort: row.effort || null,
      userExcerpt: row.user_excerpt, assistantExcerpt: row.assistant_excerpt,
      tokens: {
        input: row.input_tokens, cachedInput: row.cached_input_tokens, cacheWriteInput: row.cache_write_input_tokens,
        output: row.output_tokens, reasoningOutput: row.reasoning_output_tokens,
        responseOutput: Math.max(0, row.output_tokens - row.reasoning_output_tokens), total: row.total_tokens,
      },
      context: {
        latest: row.context_latest, peak: row.context_peak, window: row.context_window,
        latestPercent: row.context_latest && row.context_window ? row.context_latest / row.context_window * 100 : null,
        peakPercent: row.context_peak && row.context_window ? row.context_peak / row.context_window * 100 : null,
        compacted: Boolean(row.compacted),
      },
      rateLimits: parseJson(row.rate_limits_json),
      dimensions: {
        speed: dimensions.speed ?? null,
        reasoningMode: dimensions.reasoningMode ?? null,
        reasoningContext: dimensions.reasoningContext ?? null,
        executionMode: dimensions.executionMode ?? null,
        origin: dimensions.origin ?? null,
        automationKind: dimensions.automationKind ?? null,
      },
    };
    const stages = this.stageRows(turn.turnId);
    turn.stageDurations = allocateDurations(turn, stages);
    const toolStages = stages.filter((stage) => stage.kind === 'tool');
    turn.toolSummary = {
      calls: toolStages.length,
      failures: toolStages.filter((stage) => stage.metadata.toolStatus === 'failure').length,
      durationMs: toolStages.reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0),
      categories: [...new Set(toolStages.map((stage) => stage.metadata.toolCategory).filter(Boolean))],
    };
    if (turn.ttftMs === null && turn.receivedAtMs) {
      const first = stages.find((stage) => stage.kind !== 'input' && stage.startedAtMs);
      if (first) { turn.ttftMs = Math.max(0, first.startedAtMs - turn.receivedAtMs); turn.ttftProvisional = true; }
    }
    const lastStage = stages.at(-1);
    turn.currentStage = turn.status === 'running' ? (lastStage?.kind || 'processing') : 'done';
    if (turn.status === 'running' && turn.receivedAtMs) turn.durationMs = Math.max(0, Date.now() - turn.receivedAtMs);
    if (includeDetails) { turn.stages = stages; turn.usageEvents = this.usageRows(turn.turnId); }
    return turn;
  }

  filteredTurns(filters = {}) {
    const now = Date.now();
    let threshold = 0;
    if (filters.range === 'today') { const date = new Date(); date.setHours(0, 0, 0, 0); threshold = date.getTime(); }
    else if (filters.range === '7d') threshold = now - 7 * 86_400_000;
    else if (filters.range === '30d') threshold = now - 30 * 86_400_000;
    return this.turnRows().filter((turn) => {
      if (threshold && (turn.receivedAtMs ?? 0) < threshold) return false;
      if (filters.project && turn.cwd !== filters.project) return false;
      if (filters.model && turn.model !== filters.model) return false;
      if (filters.effort && (turn.effort || '') !== filters.effort) return false;
      if (filters.status && turn.status !== filters.status) return false;
      if (filters.mode && (turn.dimensions.executionMode || '') !== filters.mode) return false;
      if (filters.threadId && turn.threadId !== filters.threadId) return false;
      return true;
    });
  }

  summary(filters = {}, collectorState = {}) {
    const turns = this.filteredTurns(filters);
    const completed = turns.filter((turn) => turn.status === 'completed' && Number.isFinite(turn.durationMs));
    const durations = completed.map((turn) => turn.durationMs);
    const ttfts = completed.map((turn) => turn.ttftMs).filter(Number.isFinite);
    const latestRate = this.turnRows().find((turn) => turn.rateLimits)?.rateLimits ?? null;
    const filtersData = this.turnRows();
    return {
      generatedAtMs: Date.now(),
      importing: Boolean(collectorState.importing),
      sourceCount: this.sourceCount(),
      counts: {
        turns: turns.length, completed: completed.length,
        running: turns.filter((turn) => turn.status === 'running').length,
        aborted: turns.filter((turn) => turn.status === 'aborted').length,
      },
      metrics: {
        durationP50: percentile(durations, 0.5), durationP95: percentile(durations, 0.95),
        ttftP50: percentile(ttfts, 0.5), ttftP95: percentile(ttfts, 0.95),
        totalTokens: turns.reduce((sum, turn) => sum + turn.tokens.total, 0),
        inputTokens: turns.reduce((sum, turn) => sum + turn.tokens.input, 0),
        outputTokens: turns.reduce((sum, turn) => sum + turn.tokens.output, 0),
      },
      subscription: latestRate,
      active: turns.filter((turn) => turn.status === 'running').slice(0, 5),
      trend: turns.slice(0, 120).reverse().map((turn) => ({
        turnId: turn.turnId, threadId: turn.threadId, title: turn.title, receivedAtMs: turn.receivedAtMs,
        durationMs: turn.durationMs, ttftMs: turn.ttftMs, tokens: turn.tokens.total,
        contextPercent: turn.context.latestPercent, stageDurations: turn.stageDurations, status: turn.status,
      })),
      filters: {
        projects: [...new Map(filtersData.filter((turn) => turn.cwd).map((turn) => [turn.cwd, { value: turn.cwd, label: turn.project }])).values()],
        models: [...new Set(filtersData.map((turn) => turn.model))].sort(),
        efforts: [...new Set(filtersData.map((turn) => turn.effort).filter(Boolean))].sort(),
        statuses: [...new Set(filtersData.map((turn) => turn.status))].sort(),
        modes: [...new Set(filtersData.map((turn) => turn.dimensions.executionMode).filter(Boolean))].sort(),
      },
      diagnostics: this.diagnosticRows().slice(0, 20),
    };
  }

  analytics(filters = {}) {
    const turns = this.filteredTurns(filters);
    const completed = turns.filter((turn) => turn.status === 'completed');
    const timedCompleted = completed.filter((turn) => Number.isFinite(turn.durationMs));
    const terminal = turns.filter((turn) => ['completed', 'aborted', 'incomplete'].includes(turn.status));
    const allStages = turns.flatMap((turn) => this.stageRows(turn.turnId).map((stage) => ({ ...stage, turnId: turn.turnId, title: turn.title })));
    const toolStages = allStages.filter((stage) => stage.kind === 'tool');
    const agentStages = toolStages.filter((stage) => stage.metadata.agentId || stage.metadata.toolCategory === 'sub-agent');
    const contextValues = turns.map((turn) => turn.context.peakPercent).filter(Number.isFinite);
    const inputTokens = turns.reduce((sum, turn) => sum + turn.tokens.input, 0);
    const cachedTokens = turns.reduce((sum, turn) => sum + turn.tokens.cachedInput, 0);
    const cacheWriteTokens = turns.reduce((sum, turn) => sum + turn.tokens.cacheWriteInput, 0);
    const outputTokens = turns.reduce((sum, turn) => sum + turn.tokens.output, 0);
    const reasoningTokens = turns.reduce((sum, turn) => sum + turn.tokens.reasoningOutput, 0);
    const concurrency = concurrencyMetrics(turns);

    const efficiencyGroups = new Map();
    for (const turn of turns) {
      const effort = turn.effort || 'unknown';
      const key = `${turn.model}\u0000${effort}`;
      if (!efficiencyGroups.has(key)) efficiencyGroups.set(key, { model: turn.model, effort, turns: [] });
      efficiencyGroups.get(key).turns.push(turn);
    }
    const matrix = [...efficiencyGroups.values()].map((group) => {
      const groupCompleted = group.turns.filter((turn) => turn.status === 'completed');
      const groupTimedCompleted = groupCompleted.filter((turn) => Number.isFinite(turn.durationMs));
      const groupTerminal = group.turns.filter((turn) => ['completed', 'aborted', 'incomplete'].includes(turn.status));
      const groupInput = group.turns.reduce((sum, turn) => sum + turn.tokens.input, 0);
      const groupOutput = group.turns.reduce((sum, turn) => sum + turn.tokens.output, 0);
      return {
        model: group.model, effort: group.effort, turns: group.turns.length, completed: groupCompleted.length,
        completionRate: ratio(groupCompleted.length, groupTerminal.length),
        durationP50: percentile(groupTimedCompleted.map((turn) => turn.durationMs), 0.5),
        durationP95: percentile(groupTimedCompleted.map((turn) => turn.durationMs), 0.95),
        ttftP50: percentile(groupTimedCompleted.map((turn) => turn.ttftMs).filter(Number.isFinite), 0.5),
        averageTokens: average(group.turns.map((turn) => turn.tokens.total)),
        cacheHitRate: ratio(group.turns.reduce((sum, turn) => sum + turn.tokens.cachedInput, 0), groupInput),
        reasoningShare: ratio(group.turns.reduce((sum, turn) => sum + turn.tokens.reasoningOutput, 0), groupOutput),
      };
    }).sort((left, right) => right.turns - left.turns || left.model.localeCompare(right.model));

    const toolGroups = new Map();
    for (const stage of toolStages) {
      const category = stage.metadata.toolCategory || 'unknown';
      const name = stage.metadata.toolName || 'Unknown tool';
      const key = `${category}\u0000${name}`;
      if (!toolGroups.has(key)) toolGroups.set(key, { category, name, stages: [] });
      toolGroups.get(key).stages.push(stage);
    }
    const tools = [...toolGroups.values()].map((group) => {
      const outcomes = group.stages.map((stage) => stage.metadata.toolStatus).filter((status) => ['success', 'failure'].includes(status));
      const failures = outcomes.filter((status) => status === 'failure').length;
      const durations = group.stages.map((stage) => stage.durationMs).filter(Number.isFinite);
      return {
        category: group.category, name: group.name, calls: group.stages.length, failures,
        failureRate: ratio(failures, outcomes.length), totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
        durationP95: percentile(durations, 0.95),
      };
    }).sort((left, right) => right.calls - left.calls || right.totalDurationMs - left.totalDurationMs);
    const toolOutcomes = toolStages.map((stage) => stage.metadata.toolStatus).filter((status) => ['success', 'failure'].includes(status));
    const toolFailures = toolOutcomes.filter((status) => status === 'failure').length;

    const agentIds = new Set(agentStages.map((stage) => stage.metadata.agentId).filter(Boolean));
    const relations = [...new Map(agentStages.filter((stage) => stage.metadata.agentId).map((stage) => [
      `${stage.metadata.parentAgentId || ''}:${stage.metadata.agentId}`,
      { parentAgentId: stage.metadata.parentAgentId || null, agentId: stage.metadata.agentId },
    ])).values()];
    const agentOverlap = intervalOverlapMetrics(agentStages);

    const modeGroups = new Map();
    const automationGroups = new Map();
    for (const turn of turns) {
      const mode = turn.dimensions.executionMode || 'unknown';
      modeGroups.set(mode, (modeGroups.get(mode) || 0) + 1);
      if (turn.dimensions.automationKind) automationGroups.set(turn.dimensions.automationKind, (automationGroups.get(turn.dimensions.automationKind) || 0) + 1);
    }

    const compactStages = allStages.filter((stage) => stage.kind === 'compaction');
    return {
      generatedAtMs: Date.now(),
      coverage: {
        toolStages: toolStages.length > 0,
        toolNames: toolStages.some((stage) => Boolean(stage.metadata.toolName)),
        toolStatuses: toolStages.some((stage) => ['success', 'failure'].includes(stage.metadata.toolStatus)),
        agents: agentStages.some((stage) => Boolean(stage.metadata.agentId)),
        workModes: turns.some((turn) => Boolean(turn.dimensions.executionMode)),
        automations: turns.some((turn) => Boolean(turn.dimensions.automationKind)),
        speed: turns.some((turn) => Boolean(turn.dimensions.speed)),
        reasoningMode: turns.some((turn) => Boolean(turn.dimensions.reasoningMode)),
      },
      overview: {
        turns: turns.length, completed: completed.length, running: turns.filter((turn) => turn.status === 'running').length,
        completionRate: ratio(completed.length, terminal.length),
        durationP50: percentile(timedCompleted.map((turn) => turn.durationMs), 0.5),
        durationP95: percentile(timedCompleted.map((turn) => turn.durationMs), 0.95),
        ttftP50: percentile(timedCompleted.map((turn) => turn.ttftMs).filter(Number.isFinite), 0.5),
        totalTokens: turns.reduce((sum, turn) => sum + turn.tokens.total, 0),
        cacheHitRate: ratio(cachedTokens, inputTokens), reasoningShare: ratio(reasoningTokens, outputTokens),
        contextWarning: contextValues.filter((value) => value >= 70 && value < 85).length,
        contextDanger: contextValues.filter((value) => value >= 85).length,
        compactions: compactStages.length, currentConcurrency: concurrency.current, peakConcurrency: concurrency.peak,
      },
      efficiency: { matrix },
      cache: {
        inputTokens, cachedInputTokens: cachedTokens, cacheWriteInputTokens: cacheWriteTokens,
        hitRate: ratio(cachedTokens, inputTokens), writeRate: ratio(cacheWriteTokens, inputTokens),
        trend: turns.slice(0, 120).reverse().map((turn) => ({
          turnId: turn.turnId, title: turn.title, receivedAtMs: turn.receivedAtMs,
          inputTokens: turn.tokens.input, cachedInputTokens: turn.tokens.cachedInput,
          cacheWriteInputTokens: turn.tokens.cacheWriteInput,
        })),
      },
      tools: {
        calls: toolStages.length, failures: toolFailures, failureRate: ratio(toolFailures, toolOutcomes.length),
        totalDurationMs: toolStages.reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0), groups: tools,
      },
      agents: {
        count: agentIds.size, calls: agentStages.length, relations, ...agentOverlap,
        timeline: agentStages.slice(-120).map((stage) => ({
          turnId: stage.turnId, title: stage.title, agentId: stage.metadata.agentId || null,
          parentAgentId: stage.metadata.parentAgentId || null, startedAtMs: stage.startedAtMs,
          completedAtMs: stage.completedAtMs, durationMs: stage.durationMs, status: stage.metadata.toolStatus || 'unknown',
        })),
      },
      context: {
        peakP50: percentile(contextValues, 0.5), peakP95: percentile(contextValues, 0.95),
        warning: contextValues.filter((value) => value >= 70 && value < 85).length,
        danger: contextValues.filter((value) => value >= 85).length,
        compactions: compactStages.length,
        compactionDurationMs: compactStages.reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0),
        trend: turns.slice(0, 120).reverse().map((turn) => ({
          turnId: turn.turnId, title: turn.title, receivedAtMs: turn.receivedAtMs,
          latestPercent: turn.context.latestPercent, peakPercent: turn.context.peakPercent, compacted: turn.context.compacted,
        })),
      },
      reliability: {
        completed: completed.length, aborted: turns.filter((turn) => turn.status === 'aborted').length,
        incomplete: turns.filter((turn) => turn.status === 'incomplete').length,
        running: turns.filter((turn) => turn.status === 'running').length,
        completionRate: ratio(completed.length, terminal.length), toolFailures,
      },
      concurrency,
      workModes: {
        modes: [...modeGroups].map(([mode, count]) => ({ mode, count })).sort((left, right) => right.count - left.count),
        automations: [...automationGroups].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count),
      },
    };
  }

  taskList(filters = {}) {
    const turns = this.filteredTurns(filters);
    const grouped = new Map();
    for (const turn of turns) {
      if (!grouped.has(turn.threadId)) grouped.set(turn.threadId, { threadId: turn.threadId, title: turn.title, cwd: turn.cwd, project: turn.project, turns: [] });
      grouped.get(turn.threadId).turns.push(turn);
    }
    return [...grouped.values()].map((task) => ({
      ...task,
      revision: Math.max(...task.turns.map((turn) => turn.updatedAtMs ?? 0)),
      lastActivityMs: Math.max(...task.turns.map((turn) => turn.receivedAtMs ?? 0)),
      totalTokens: task.turns.reduce((sum, turn) => sum + turn.tokens.total, 0),
      totalDurationMs: task.turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0),
      completionRate: ratio(task.turns.filter((turn) => turn.status === 'completed').length,
        task.turns.filter((turn) => ['completed', 'aborted', 'incomplete'].includes(turn.status)).length),
      toolCalls: task.turns.reduce((sum, turn) => sum + turn.toolSummary.calls, 0),
      toolFailures: task.turns.reduce((sum, turn) => sum + turn.toolSummary.failures, 0),
      modes: [...new Set(task.turns.map((turn) => turn.dimensions.executionMode).filter(Boolean))],
    })).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  taskTurns(threadId, filters = {}) {
    return this.filteredTurns({ ...filters, threadId }).map((turn) => {
      const row = this.db.prepare(`SELECT t.*,th.title,th.cwd,th.session_id,th.dimensions_json AS thread_dimensions_json FROM turns t LEFT JOIN threads th ON th.thread_id=t.thread_id WHERE t.turn_id=?`).get(turn.turnId);
      return this.mapTurn(row, true);
    });
  }
}

export class TelemetryCollector extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.timer = null;
    this.scanning = false;
    this.importing = true;
    this.initialScanDone = false;
  }

  start() {
    if (this.timer) return;
    this.scanAll().catch((error) => this.emit('error', error));
    this.timer = setInterval(() => this.scanAll().catch((error) => this.emit('error', error)), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async scanAll() {
    if (this.scanning) return false;
    this.scanning = true;
    let changed = false;
    try {
      changed = await this.scanSessionIndex() || changed;
      const files = [
        ...walkJsonl(join(this.codexHome, 'sessions')),
        ...walkJsonl(join(this.codexHome, 'archived_sessions')),
      ];
      for (const file of files) changed = await this.scanFile(file) || changed;
      this.store.db.prepare("UPDATE turns SET status='incomplete',updated_at_ms=? WHERE status='running' AND received_at_ms < ? AND turn_id NOT IN (SELECT current_turn_id FROM source_files WHERE current_turn_id IS NOT NULL)").run(Date.now(), Date.now() - 86_400_000);
    } finally {
      this.initialScanDone = true;
      this.importing = false;
      this.scanning = false;
    }
    if (changed) this.emit('change', { at: Date.now() });
    return changed;
  }

  async scanSessionIndex() {
    const indexPath = join(this.codexHome, 'session_index.jsonl');
    if (!existsSync(indexPath)) return false;
    const mtimeMs = Math.round(statSync(indexPath).mtimeMs);
    const previousMtime = numberOrNull(this.store.getSetting('session_index_mtime_ms')) ?? 0;
    if (mtimeMs <= previousMtime) return false;
    let changed = false;
    const text = await readFile(indexPath, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id) { this.store.upsertThread({ threadId: item.id, title: truncateUnicode(item.thread_name, 200) }); changed = true; }
      } catch { this.store.recordDiagnostic('invalid_session_index_line'); }
    }
    this.store.setSetting('session_index_mtime_ms', String(mtimeMs));
    return changed;
  }

  async scanFile(sourcePath) {
    let stats;
    try { stats = statSync(sourcePath); } catch { return false; }
    const existing = this.store.getSource(sourcePath);
    const source = {
      sourcePath,
      byteOffset: Number(existing?.byte_offset ?? 0),
      partialLine: existing?.partial_line ?? '',
      fileSize: stats.size,
      mtimeMs: stats.mtimeMs,
      threadId: existing?.thread_id ?? null,
      sessionId: existing?.session_id ?? null,
      currentTurnId: existing?.current_turn_id ?? null,
    };
    if (stats.size < source.byteOffset) { source.byteOffset = 0; source.partialLine = ''; }
    if (stats.size === source.byteOffset) return false;
    const decoder = new StringDecoder('utf8');
    let carry = source.partialLine;
    let changed = false;
    for await (const chunk of createReadStream(sourcePath, { start: source.byteOffset })) {
      carry += decoder.write(chunk);
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) changed = this.processLine(line.replace(/\r$/u, ''), source) || changed;
    }
    carry += decoder.end();
    source.byteOffset = stats.size;
    source.partialLine = carry;
    this.store.saveSource(source);
    return changed;
  }

  processLine(line, source) {
    if (!line.trim()) return false;
    let record;
    try { record = JSON.parse(line); } catch { this.store.recordDiagnostic('invalid_jsonl_line'); return false; }
    const payload = record.payload ?? {};
    const timestampMs = toEpochMs(record.timestamp) ?? Date.now();
    const cutoff = numberOrNull(this.store.getSetting('import_cutoff_ms')) ?? 0;

    if (record.type === 'session_meta') {
      const threadId = payload.id || payload.session_id || source.threadId;
      source.threadId = threadId;
      source.sessionId = payload.session_id || payload.id || source.sessionId;
      this.store.upsertThread({
        threadId, sessionId: source.sessionId, cwd: payload.cwd ?? null, sourcePath: source.sourcePath,
        dimensions: extractDimensions(payload),
        createdAtMs: toEpochMs(payload.timestamp) ?? timestampMs,
      });
      return true;
    }

    if (record.type === 'turn_context') {
      const turnId = payload.turn_id || source.currentTurnId;
      const threadId = source.threadId || payload.thread_id || turnId;
      if (threadId) this.store.upsertThread({ threadId, cwd: payload.cwd ?? null, sourcePath: source.sourcePath });
      if (turnId && timestampMs >= cutoff) {
        this.store.ensureTurn({ turnId, threadId, sourcePath: source.sourcePath });
        this.store.updateTurn(turnId, {
          model: payload.model ?? null,
          effort: payload.effort ?? null,
          dimensions: extractDimensions(payload),
        });
      }
      return true;
    }

    if (timestampMs < cutoff) return false;
    const type = payload.type;
    if (type === 'task_started') {
      if (source.currentTurnId && source.currentTurnId !== payload.turn_id) this.store.markIncomplete(source.currentTurnId);
      source.currentTurnId = payload.turn_id;
      const threadId = payload.thread_id || source.threadId || payload.turn_id;
      this.store.ensureTurn({ turnId: payload.turn_id, threadId, sourcePath: source.sourcePath, receivedAtMs: toEpochMs(payload.started_at) ?? timestampMs });
      this.store.updateTurn(payload.turn_id, { dimensions: extractDimensions(payload) });
      return true;
    }
    if (type === 'thread_settings_applied') {
      const turnId = payload.turn_id || source.currentTurnId;
      if (!turnId) return false;
      const threadId = payload.thread_id || source.threadId || turnId;
      this.store.ensureTurn({ turnId, threadId, sourcePath: source.sourcePath });
      this.store.updateTurn(turnId, {
        model: payload.model ?? undefined,
        effort: payload.effort ?? payload.reasoning_effort ?? undefined,
        dimensions: extractDimensions(payload),
      });
      return true;
    }
    if (type === 'item_completed') {
      const turnId = payload.turn_id || source.currentTurnId;
      if (!turnId) return false;
      const threadId = payload.thread_id || source.threadId || turnId;
      this.store.ensureTurn({ turnId, threadId, sourcePath: source.sourcePath });
      const item = payload.item ?? {};
      const startedAtMs = toEpochMs(payload.started_at_ms) ?? timestampMs;
      const completedAtMs = toEpochMs(payload.completed_at_ms) ?? timestampMs;
      const inserted = this.store.addStage(turnId, item, startedAtMs, completedAtMs);
      if (item.type === 'UserMessage') this.store.updateTurn(turnId, { userSentAtMs: startedAtMs, userExcerpt: extractMessageExcerpt(item.content) });
      if (item.type === 'AgentMessage') this.store.updateTurn(turnId, { assistantExcerpt: extractMessageExcerpt(item.content) });
      return inserted || item.type === 'UserMessage' || item.type === 'AgentMessage';
    }
    if (type === 'token_count') {
      const turnId = source.currentTurnId;
      if (!turnId || !payload.info) return false;
      return this.store.addUsage(turnId, timestampMs, payload.info, payload.rate_limits);
    }
    if (type === 'task_complete' || type === 'turn_aborted') {
      const turnId = payload.turn_id || source.currentTurnId;
      if (!turnId) return false;
      const startedAtMs = toEpochMs(payload.started_at);
      const durationMs = numberOrNull(payload.duration_ms);
      const completedAtMs = startedAtMs !== null && durationMs !== null ? startedAtMs + durationMs : toEpochMs(payload.completed_at) ?? timestampMs;
      this.store.updateTurn(turnId, {
        status: type === 'task_complete' ? 'completed' : 'aborted',
        receivedAtMs: startedAtMs, completedAtMs, durationMs,
        ttftMs: numberOrNull(payload.time_to_first_token_ms),
        assistantExcerpt: type === 'task_complete' ? truncateUnicode(payload.last_agent_message, 160) : undefined,
      });
      if (source.currentTurnId === turnId) source.currentTurnId = null;
      return true;
    }
    if (record.type === 'event_msg' && type && !KNOWN_PAYLOAD_TYPES.has(type)) {
      this.store.recordDiagnostic(type, timestampMs);
    }
    return false;
  }

  async reimport() {
    while (this.scanning) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    this.store.resetForReimport();
    this.store.setSetting('session_index_mtime_ms', '0');
    this.importing = true;
    return this.scanAll();
  }
}

export function createFixtureRecord(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}
