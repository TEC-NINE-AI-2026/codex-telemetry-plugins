const tokenFromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenFromHash) {
  sessionStorage.setItem('codexTelemetryToken', tokenFromHash);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const accessToken = sessionStorage.getItem('codexTelemetryToken');

const state = {
  summary: null,
  tasks: [],
  openTask: null,
  taskTurns: new Map(),
  loading: false,
  refreshTimer: null,
  filters: { range: '7d', project: '', model: '', status: '' },
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function formatDate(value, includeDate = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: includeDate ? '2-digit' : undefined, day: includeDate ? '2-digit' : undefined,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function statusLabel(status) {
  return ({ completed: '已完成', running: '运行中', aborted: '已中止', incomplete: '不完整' })[status] || status;
}

function stageLabel(kind) {
  return ({ receive: '接收 / TTFT', reasoning: '推理', tool: '工具', commentary: '中间回复', final: '最终回复', other: '其他开销', input: '用户消息', compaction: '上下文压缩', processing: '处理中', done: '已结束' })[kind] || kind;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'X-Dashboard-Token': accessToken, 'Content-Type': 'application/json', ...(options.headers || {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function queryString() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  return params.toString();
}

function connection(status, text) {
  const node = $('#connection');
  node.className = `status-pill ${status}`;
  node.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function showError(message) {
  const banner = $('#error-banner');
  if (!message) { banner.classList.add('hidden'); banner.textContent = ''; return; }
  banner.textContent = message;
  banner.classList.remove('hidden');
}

async function loadDashboard({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) connection('pending', '正在更新');
  try {
    const query = queryString();
    const [summary, taskPayload] = await Promise.all([api(`/api/summary?${query}`), api(`/api/tasks?${query}`)]);
    state.summary = summary;
    state.tasks = taskPayload.tasks;
    render();
    connection('online', '实时连接');
    showError('');
  } catch (error) {
    connection('offline', '连接失败');
    showError(`无法读取本地指标：${error.message}`);
  } finally {
    state.loading = false;
  }
}

function updateSelect(selector, values, placeholder) {
  const select = $(selector);
  const selected = select.value;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${values.map((entry) => {
    const value = typeof entry === 'string' ? entry : entry.value;
    const label = typeof entry === 'string' ? entry : entry.label;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('')}`;
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function render() {
  const summary = state.summary;
  if (!summary) return;
  $('#updated-at').textContent = `更新于 ${formatDate(summary.generatedAtMs)}`;
  $('#source-count').textContent = `${summary.sourceCount} 个日志源`;
  $('#import-banner').classList.toggle('hidden', !summary.importing);
  renderActive(summary.active);
  renderSubscription(summary.subscription);
  renderKpis(summary);
  renderLatencyChart(summary.trend);
  renderTokenChart(summary.trend);
  renderTasks(state.tasks);
  renderDiagnostics(summary.diagnostics);
  updateSelect('#project-filter', summary.filters.projects, '全部项目');
  updateSelect('#model-filter', summary.filters.models, '全部模型');
  updateSelect('#status-filter', summary.filters.statuses.map((value) => ({ value, label: statusLabel(value) })), '全部状态');
}

function renderActive(active) {
  const section = $('#active-section');
  section.classList.toggle('hidden', !active.length);
  $('#active-turns').innerHTML = active.map((turn) => `
    <article class="active-card" data-start="${turn.receivedAtMs || 0}">
      <div class="task-title"><strong>${escapeHtml(turn.title)}</strong></div>
      <div class="active-time">${formatDuration(turn.durationMs)}</div>
      <span class="badge running">${escapeHtml(stageLabel(turn.currentStage))}</span>
      <p class="task-path">${escapeHtml(turn.project)} · ${escapeHtml(turn.model)}</p>
    </article>`).join('');
}

function renderSubscription(rateLimits) {
  const container = $('#subscription');
  if (!rateLimits) {
    $('#plan-type').textContent = 'Codex 未提供';
    container.innerHTML = '<div class="empty-state compact">等待首个 usage 快照</div>';
    return;
  }
  $('#plan-type').textContent = `${rateLimits.plan_type || '未知方案'}${rateLimits.limit_name ? ` · ${rateLimits.limit_name}` : ''}`;
  const windows = [['primary', rateLimits.primary], ['secondary', rateLimits.secondary]].filter(([, value]) => value);
  const windowCards = windows.map(([name, value]) => {
    const percent = clamp(Number(value.used_percent) || 0, 0, 100);
    const windowMinutes = Number(value.window_minutes);
    const label = windowMinutes === 300 ? '5 小时窗口' : windowMinutes === 10080 ? '7 天窗口' : `${formatDuration(windowMinutes * 60_000)}窗口`;
    const reset = value.resets_at ? toMs(value.resets_at) : null;
    return `<article class="subscription-card">
      <p class="eyebrow">${escapeHtml(name.toUpperCase())}</p>
      <div class="value-row"><h3>${escapeHtml(label)}</h3><strong>${percent.toFixed(0)}%</strong></div>
      <progress max="100" value="${percent}" aria-label="${escapeHtml(label)}已使用 ${percent}%"></progress>
      <p class="muted">${reset ? `重置于 ${formatDate(reset)}` : '重置时间未提供'}</p>
    </article>`;
  });
  const credits = rateLimits.credits;
  if (credits) windowCards.push(`<article class="subscription-card">
    <p class="eyebrow">CREDITS</p><div class="value-row"><h3>额外额度</h3><strong>${escapeHtml(credits.unlimited ? '不限量' : credits.balance ?? '0')}</strong></div>
    <p class="muted">${credits.has_credits ? '当前有可用 credits' : '当前无额外 credits'}</p>
  </article>`);
  container.innerHTML = windowCards.join('');
}

function toMs(value) { const numeric = Number(value); return Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : null; }

function renderKpis(summary) {
  const items = [
    ['轮次', String(summary.counts.turns), `${summary.counts.completed} 完成 · ${summary.counts.running} 运行`],
    ['总耗时 P50', formatDuration(summary.metrics.durationP50), `P95 ${formatDuration(summary.metrics.durationP95)}`],
    ['首 Token P50', formatDuration(summary.metrics.ttftP50), `P95 ${formatDuration(summary.metrics.ttftP95)}`],
    ['总 Token', formatTokens(summary.metrics.totalTokens), `输入 ${formatTokens(summary.metrics.inputTokens)} · 输出 ${formatTokens(summary.metrics.outputTokens)}`],
  ];
  $('#kpis').innerHTML = items.map(([label, value, detail]) => `<article class="kpi"><p class="label">${escapeHtml(label)}</p><div class="value">${escapeHtml(value)}</div><p class="detail">${escapeHtml(detail)}</p></article>`).join('');
}

const stageKeys = ['receive', 'reasoning', 'tool', 'commentary', 'final', 'other'];
function renderLatencyChart(trend) {
  const container = $('#latency-chart');
  $('#latency-legend').innerHTML = stageKeys.map((key) => `<span><i class="swatch ${key}"></i>${escapeHtml(stageLabel(key))}</span>`).join('');
  if (!trend.length) { container.innerHTML = '<div class="chart-empty">当前筛选范围没有轮次数据</div>'; return; }
  const width = 860; const height = 230; const pad = { left: 50, right: 10, top: 12, bottom: 28 };
  const chartHeight = height - pad.top - pad.bottom;
  const data = trend.slice(-60);
  const max = Math.max(...data.map((entry) => entry.durationMs || 0), 1);
  const gap = 2; const barWidth = Math.max(2, (width - pad.left - pad.right) / data.length - gap);
  const grid = [0, .25, .5, .75, 1].map((ratio) => {
    const y = pad.top + chartHeight * (1 - ratio);
    return `<line class="chart-grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/><text class="chart-axis" x="${pad.left - 7}" y="${y + 3}" text-anchor="end">${escapeHtml(formatDuration(max * ratio))}</text>`;
  }).join('');
  const bars = data.map((entry, index) => {
    const x = pad.left + index * ((width - pad.left - pad.right) / data.length) + gap / 2;
    let cursor = pad.top + chartHeight;
    const total = Math.max(entry.durationMs || 0, 1);
    const segments = stageKeys.map((key) => {
      const value = entry.stageDurations?.[key] || 0;
      const segmentHeight = chartHeight * value / max;
      cursor -= segmentHeight;
      return segmentHeight > 0 ? `<rect class="bar-${key}" x="${x}" y="${cursor}" width="${barWidth}" height="${Math.max(1, segmentHeight)}" rx="1"><title>${escapeHtml(`${entry.title}\n${stageLabel(key)} ${formatDuration(value)}\n总计 ${formatDuration(total)}`)}</title></rect>` : '';
    }).join('');
    return segments;
  }).join('');
  const labels = axisLabels(data, width, pad, height);
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="轮次耗时阶段堆叠图">${grid}${bars}${labels}</svg>`;
}

function axisLabels(data, width, pad, height) {
  const candidates = [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])];
  return candidates.map((index) => {
    const x = pad.left + (index + .5) * ((width - pad.left - pad.right) / data.length);
    return `<text class="chart-axis" x="${x}" y="${height - 7}" text-anchor="middle">${escapeHtml(formatDate(data[index].receivedAtMs, true).slice(0, 11))}</text>`;
  }).join('');
}

function renderTokenChart(trend) {
  const container = $('#token-chart');
  if (!trend.length) { container.innerHTML = '<div class="chart-empty">当前筛选范围没有 Token 数据</div>'; return; }
  const width = 700; const height = 230; const pad = { left: 48, right: 28, top: 12, bottom: 28 };
  const chartHeight = height - pad.top - pad.bottom;
  const data = trend.slice(-60);
  const maxTokens = Math.max(...data.map((entry) => entry.tokens || 0), 1);
  const cell = (width - pad.left - pad.right) / data.length;
  const barWidth = Math.max(2, cell - 2);
  const grid = [0, .5, 1].map((ratio) => {
    const y = pad.top + chartHeight * (1 - ratio);
    return `<line class="chart-grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"/><text class="chart-axis" x="${pad.left - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(formatTokens(maxTokens * ratio))}</text>`;
  }).join('');
  const bars = data.map((entry, index) => {
    const x = pad.left + index * cell + 1;
    const barHeight = chartHeight * (entry.tokens || 0) / maxTokens;
    return `<rect class="bar-token" x="${x}" y="${pad.top + chartHeight - barHeight}" width="${barWidth}" height="${Math.max(1, barHeight)}" rx="1"><title>${escapeHtml(`${entry.title}\n${formatTokens(entry.tokens)} Token`)}</title></rect>`;
  }).join('');
  const points = data.map((entry, index) => {
    const percent = clamp(entry.contextPercent || 0, 0, 100);
    return `${pad.left + (index + .5) * cell},${pad.top + chartHeight * (1 - percent / 100)}`;
  }).join(' ');
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token 和上下文占用趋势图">${grid}${bars}<polyline class="context-line" points="${points}" fill="none"/>${axisLabels(data, width, pad, height)}<text class="chart-axis" x="${width - 2}" y="${pad.top + 3}" text-anchor="end">100%</text></svg>`;
}

function renderTasks(tasks) {
  $('#task-count').textContent = `${tasks.length} 个任务`;
  const container = $('#task-list');
  if (!tasks.length) { container.innerHTML = '<div class="empty-state">当前筛选范围没有任务</div>'; return; }
  container.innerHTML = tasks.map((task) => {
    const open = state.openTask === task.threadId;
    return `<article class="task-card ${open ? 'open' : ''}" data-thread="${escapeHtml(task.threadId)}">
      <button class="task-summary" type="button" data-action="toggle-task" data-thread="${escapeHtml(task.threadId)}">
        <div><h3 class="task-title">${escapeHtml(task.title)}</h3><p class="task-path" title="${escapeHtml(task.cwd || '')}">${escapeHtml(task.project)} · ${escapeHtml(task.cwd || '路径未知')}</p></div>
        <div class="metric-mini"><strong>${task.turns.length}</strong>轮次</div>
        <div class="metric-mini hide-small"><strong>${escapeHtml(formatDuration(task.totalDurationMs))}</strong>总耗时</div>
        <div class="metric-mini hide-medium"><strong>${escapeHtml(formatTokens(task.totalTokens))}</strong>Token</div>
        <span class="chevron">›</span>
      </button>
      ${open ? `<div class="turns" id="turns-${escapeHtml(task.threadId)}">${renderTurnRows(state.taskTurns.get(task.threadId))}</div>` : ''}
    </article>`;
  }).join('');
}

function renderTurnRows(turns) {
  if (!turns) return '<div class="empty-state compact">正在读取轮次明细…</div>';
  if (!turns.length) return '<div class="empty-state compact">没有轮次</div>';
  return turns.map((turn) => `<div class="turn-row" role="button" tabindex="0" data-action="open-turn" data-thread="${escapeHtml(turn.threadId)}" data-turn="${escapeHtml(turn.turnId)}">
    <div><span class="badge ${escapeHtml(turn.status)}">${escapeHtml(statusLabel(turn.status))}</span><p class="task-path">${escapeHtml(formatDate(turn.receivedAtMs, false))}</p></div>
    <div class="excerpt"><p>${escapeHtml(turn.userExcerpt || '未记录用户消息摘录')}</p><p class="answer">${escapeHtml(turn.assistantExcerpt || '尚无最终回复摘录')}</p></div>
    <div class="metric-mini"><strong>${escapeHtml(formatDuration(turn.durationMs))}</strong>总耗时</div>
    <div class="metric-mini hide-small"><strong>${escapeHtml(formatDuration(turn.ttftMs))}</strong>TTFT</div>
    <div class="metric-mini hide-medium"><strong>${escapeHtml(formatTokens(turn.tokens.total))}</strong>Token</div>
    <div class="metric-mini hide-medium"><strong>${turn.context.latestPercent === null ? '—' : `${turn.context.latestPercent.toFixed(1)}%`}</strong>上下文</div>
  </div>`).join('');
}

async function toggleTask(threadId) {
  if (state.openTask === threadId) { state.openTask = null; renderTasks(state.tasks); return; }
  state.openTask = threadId;
  renderTasks(state.tasks);
  if (!state.taskTurns.has(threadId)) {
    try {
      const payload = await api(`/api/tasks/${encodeURIComponent(threadId)}/turns`);
      state.taskTurns.set(threadId, payload.turns);
      renderTasks(state.tasks);
    } catch (error) { showError(`无法读取任务详情：${error.message}`); }
  }
}

function openTurn(threadId, turnId) {
  const turn = state.taskTurns.get(threadId)?.find((item) => item.turnId === turnId);
  if (!turn) return;
  $('#dialog-title').textContent = turn.title;
  $('#dialog-body').innerHTML = renderTurnDetails(turn);
  $('#turn-dialog').showModal();
}

function renderTurnDetails(turn) {
  const details = [
    ['状态', statusLabel(turn.status)], ['模型', `${turn.model}${turn.effort ? ` · ${turn.effort}` : ''}`],
    ['接收时间', formatDate(turn.receivedAtMs)], ['结束时间', formatDate(turn.completedAtMs)],
    ['总耗时', formatDuration(turn.durationMs)], ['首 Token', `${formatDuration(turn.ttftMs)}${turn.ttftProvisional ? '（暂定）' : ''}`],
    ['输入 Token', formatTokens(turn.tokens.input)], ['缓存输入', formatTokens(turn.tokens.cachedInput)],
    ['输出 Token', formatTokens(turn.tokens.output)], ['推理 Token', formatTokens(turn.tokens.reasoningOutput)],
    ['上下文', turn.context.latest ? `${formatTokens(turn.context.latest)} / ${formatTokens(turn.context.window)} (${turn.context.latestPercent?.toFixed(1)}%)` : 'Codex 未提供'],
    ['上下文峰值', turn.context.peak ? `${formatTokens(turn.context.peak)} (${turn.context.peakPercent?.toFixed(1)}%)${turn.context.compacted ? ' · 已压缩' : ''}` : 'Codex 未提供'],
  ];
  return `
    <div class="detail-grid">${details.map(([label, value]) => `<div class="detail-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
    <h3 class="subheading">消息摘录</h3>
    <div class="message-box"><strong>你：</strong> ${escapeHtml(turn.userExcerpt || '未记录')}</div>
    <div class="message-box"><strong>Codex：</strong> ${escapeHtml(turn.assistantExcerpt || '尚无最终回复')}</div>
    <h3 class="subheading">阶段瀑布图</h3>
    ${renderWaterfall(turn)}
    <h3 class="subheading">原始阶段事件</h3>
    ${renderStageTable(turn.stages)}
    <h3 class="subheading">模型调用 Token 快照</h3>
    ${renderUsageTable(turn.usageEvents)}
  `;
}

function renderWaterfall(turn) {
  const stages = turn.stages.filter((stage) => stage.startedAtMs && stage.completedAtMs);
  const start = turn.receivedAtMs || Math.min(...stages.map((stage) => stage.startedAtMs));
  const duration = Math.max(turn.durationMs || 0, 1);
  const width = 860; const labelWidth = 96; const trackWidth = width - labelWidth - 8; const rowHeight = 25;
  const rows = [];
  if (turn.ttftMs) rows.push({ kind: 'receive', rawType: 'TimeToFirstToken', startedAtMs: start, completedAtMs: start + turn.ttftMs, durationMs: turn.ttftMs });
  rows.push(...stages);
  const body = rows.map((stage, index) => {
    const x = labelWidth + clamp((stage.startedAtMs - start) / duration, 0, 1) * trackWidth;
    const barWidth = Math.max(2, clamp((stage.completedAtMs - stage.startedAtMs) / duration, 0, 1) * trackWidth);
    const y = 8 + index * rowHeight;
    return `<text class="chart-axis" x="0" y="${y + 11}">${escapeHtml(stageLabel(stage.kind))}</text><rect class="waterfall-track-svg" x="${labelWidth}" y="${y}" width="${trackWidth}" height="14" rx="4"/><rect class="bar-${escapeHtml(stage.kind)}" x="${x}" y="${y}" width="${barWidth}" height="14" rx="4"><title>${escapeHtml(`${stage.rawType} · ${formatDuration(stage.durationMs)}`)}</title></rect>`;
  }).join('');
  return `<div class="waterfall"><svg viewBox="0 0 ${width} ${Math.max(40, rows.length * rowHeight + 12)}" role="img" aria-label="轮次阶段瀑布图">${body}</svg></div>`;
}

function renderStageTable(stages) {
  if (!stages.length) return '<div class="empty-state compact">没有阶段事件</div>';
  return `<div class="table-scroll"><table class="event-table"><thead><tr><th>阶段</th><th>原始类型</th><th>开始</th><th>结束</th><th>耗时</th></tr></thead><tbody>${stages.map((stage) => `<tr><td>${escapeHtml(stageLabel(stage.kind))}</td><td>${escapeHtml(stage.rawType)}</td><td>${escapeHtml(formatDate(stage.startedAtMs))}</td><td>${escapeHtml(formatDate(stage.completedAtMs))}</td><td>${escapeHtml(formatDuration(stage.durationMs))}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderUsageTable(events) {
  if (!events.length) return '<div class="empty-state compact">Codex 未提供 Token 快照</div>';
  return `<div class="table-scroll"><table class="event-table"><thead><tr><th>时间</th><th>输入</th><th>缓存</th><th>输出</th><th>推理</th><th>总计</th><th>上下文</th></tr></thead><tbody>${events.map((event) => `<tr><td>${escapeHtml(formatDate(event.timestampMs))}</td><td>${escapeHtml(formatTokens(event.tokens.input))}</td><td>${escapeHtml(formatTokens(event.tokens.cachedInput))}</td><td>${escapeHtml(formatTokens(event.tokens.output))}</td><td>${escapeHtml(formatTokens(event.tokens.reasoningOutput))}</td><td>${escapeHtml(formatTokens(event.tokens.total))}</td><td>${event.context.input && event.context.window ? `${(event.context.input / event.context.window * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderDiagnostics(rows) {
  $('#diagnostic-count').textContent = String(rows.length);
  $('#diagnostics-content').innerHTML = rows.length ? rows.map((row) => `<div class="diagnostic-row"><span>${escapeHtml(row.event_type)}</span><span>${escapeHtml(row.event_count)} 次 · ${escapeHtml(formatDate(row.last_seen_ms))}</span></div>`).join('') : '<p class="muted">没有未知事件。</p>';
}

async function streamEvents() {
  while (accessToken) {
    try {
      const response = await fetch('/api/events', { headers: { 'X-Dashboard-Token': accessToken }, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      connection('online', '实时连接');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';
        for (const message of messages) {
          if (message.includes('event: refresh') || message.includes('event: diagnostic')) scheduleRefresh();
        }
      }
    } catch {
      connection('offline', '正在重连');
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.taskTurns.clear();
    loadDashboard({ quiet: true });
  }, 250);
}

document.addEventListener('click', async (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget?.dataset.action === 'toggle-task') return toggleTask(actionTarget.dataset.thread);
  if (actionTarget?.dataset.action === 'open-turn') return openTurn(actionTarget.dataset.thread, actionTarget.dataset.turn);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const target = event.target.closest('[data-action="open-turn"]');
    if (target) openTurn(target.dataset.thread, target.dataset.turn);
  }
});

for (const [selector, key] of [['#range-filter', 'range'], ['#project-filter', 'project'], ['#model-filter', 'model'], ['#status-filter', 'status']]) {
  $(selector).addEventListener('change', (event) => { state.filters[key] = event.target.value; state.openTask = null; state.taskTurns.clear(); loadDashboard(); });
}

$('#close-dialog').addEventListener('click', () => $('#turn-dialog').close());
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('这会清除已完成轮次的本地指标缓存，但不会删除 Codex 原始日志。继续吗？')) return;
  if (!confirm('请再次确认：清空后将从下一轮继续采集；如需恢复历史，可使用“重新导入”。')) return;
  try { await api('/api/history/clear', { method: 'POST', body: JSON.stringify({ confirm: 'CLEAR_METRICS' }) }); state.taskTurns.clear(); await loadDashboard(); }
  catch (error) { showError(`清空失败：${error.message}`); }
});

$('#reimport').addEventListener('click', async () => {
  if (!confirm('将从 Codex 原始日志重新构建全部指标，期间数据会逐步出现。继续吗？')) return;
  try { await api('/api/history/reimport', { method: 'POST', body: JSON.stringify({ confirm: 'REIMPORT_ALL' }) }); state.taskTurns.clear(); await loadDashboard(); }
  catch (error) { showError(`重新导入失败：${error.message}`); }
});

setInterval(() => {
  document.querySelectorAll('.active-card[data-start]').forEach((card) => {
    const started = Number(card.dataset.start);
    if (started) card.querySelector('.active-time').textContent = formatDuration(Date.now() - started);
  });
}, 1000);

if (!accessToken) {
  $('#auth-screen').classList.remove('hidden');
  connection('offline', '缺少令牌');
} else {
  loadDashboard();
  streamEvents();
}
