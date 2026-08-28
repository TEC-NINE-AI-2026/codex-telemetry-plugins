import { taskCacheNeedsRefresh, taskRevision, waterfallTimeline } from './dashboard-state.mjs';

const tokenFromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenFromHash) {
  sessionStorage.setItem('codexTelemetryToken', tokenFromHash);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const accessToken = sessionStorage.getItem('codexTelemetryToken');

const state = {
  summary: null,
  analytics: null,
  tasks: [],
  openTask: null,
  taskTurns: new Map(),
  taskTurnErrors: new Map(),
  taskTurnRequests: new Map(),
  filterGeneration: 0,
  loading: false,
  refreshQueued: false,
  refreshTimer: null,
  activeTab: 'overview',
  filters: { range: '7d', project: '', model: '', effort: '', status: '', mode: '' },
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
  return minutes < 60 ? `${minutes}m ${seconds}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

function formatPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function formatContextPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

function statusLabel(status) {
  return ({ completed: '已完成', running: '运行中', aborted: '已中止', incomplete: '不完整', success: '成功', failure: '失败', cancelled: '已取消', unknown: '未知' })[status] || status;
}

function modeLabel(mode) {
  return ({ local: '本地', worktree: 'Worktree', cloud: '云端', handoff: 'Handoff', background: '后台', automation: '自动化', unknown: 'Codex 未提供' })[mode] || mode;
}

function categoryLabel(category) {
  return ({ shell: 'Shell', mcp: 'MCP', plugin: '插件/动态工具', 'file-change': '文件变更', image: '图片查看', 'computer-use': 'Computer Use', 'sub-agent': '子智能体', 'file-search': '文件搜索', 'web-search': '网页搜索', 'code-interpreter': '代码解释器', unknown: '未知工具' })[category] || category;
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
  banner.textContent = message || '';
  banner.classList.toggle('hidden', !message);
}

async function loadDashboard({ quiet = false } = {}) {
  if (state.loading) { state.refreshQueued = true; return; }
  state.loading = true;
  if (!quiet) connection('pending', '正在更新');
  try {
    const query = queryString();
    const [summary, analytics, taskPayload] = await Promise.all([
      api(`/api/summary?${query}`), api(`/api/analytics?${query}`), api(`/api/tasks?${query}`),
    ]);
    state.summary = summary;
    state.analytics = analytics;
    state.tasks = taskPayload.tasks;
    $('#version-badge').textContent = summary.version ? `v${summary.version}` : '版本未知';
    if (state.openTask && !state.tasks.some((task) => task.threadId === state.openTask)) state.openTask = null;
    render();
    const openTask = state.tasks.find((task) => task.threadId === state.openTask);
    const cached = state.taskTurns.get(state.openTask);
    if (taskCacheNeedsRefresh(cached, openTask)) loadTaskTurns(state.openTask);
    connection('online', '实时连接');
    showError('');
  } catch (error) {
    connection('offline', '连接失败');
    showError(`无法读取本地指标：${error.message}`);
  } finally {
    state.loading = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      queueMicrotask(() => loadDashboard({ quiet: true }));
    }
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

function renderKpis(selector, items) {
  $(selector).innerHTML = items.map(([title, value, detail, tone = '']) => `<article class="kpi ${escapeHtml(tone)}"><p class="eyebrow">${escapeHtml(title)}</p><div class="value">${escapeHtml(value)}</div><p class="detail">${escapeHtml(detail)}</p></article>`).join('');
}

function empty(text) { return `<div class="empty-state compact">${escapeHtml(text)}</div>`; }

function render() {
  const { summary, analytics } = state;
  if (!summary || !analytics) return;
  $('#updated-at').textContent = `更新于 ${formatDate(summary.generatedAtMs)}`;
  $('#source-count').textContent = `${summary.sourceCount} 个日志源`;
  $('#import-banner').classList.toggle('hidden', !summary.importing);
  renderActive(summary.active);
  renderSubscription(summary.subscription);
  renderOverview(analytics);
  renderEfficiency(analytics);
  renderTools(analytics);
  renderContext(analytics);
  renderTasks(state.tasks);
  renderDiagnostics(summary.diagnostics);
  updateSelect('#project-filter', summary.filters.projects, '全部项目');
  updateSelect('#model-filter', summary.filters.models, '全部模型');
  updateSelect('#effort-filter', summary.filters.efforts, '全部强度');
  updateSelect('#status-filter', summary.filters.statuses.map((value) => ({ value, label: statusLabel(value) })), '全部状态');
  updateSelect('#mode-filter', summary.filters.modes.map((value) => ({ value, label: modeLabel(value) })), '全部模式');
}

function renderActive(active) {
  $('#active-section').classList.toggle('hidden', !active.length);
  $('#active-turns').innerHTML = active.map((turn) => `<article class="active-card" data-start="${turn.receivedAtMs || 0}"><div class="task-title"><strong>${escapeHtml(turn.title)}</strong></div><div class="active-time">${formatDuration(turn.durationMs)}</div><span class="badge running">${escapeHtml(stageLabel(turn.currentStage))}</span><p class="task-path">${escapeHtml(turn.project)} · ${escapeHtml(turn.model)}</p></article>`).join('');
}

function renderSubscription(rateLimits) {
  const container = $('#subscription');
  if (!rateLimits) {
    $('#plan-type').textContent = 'Codex 未提供';
    container.innerHTML = empty('等待首个 usage 快照');
    return;
  }
  $('#plan-type').textContent = `${rateLimits.plan_type || '未知方案'}${rateLimits.limit_name ? ` · ${rateLimits.limit_name}` : ''}`;
  const cards = [['primary', rateLimits.primary], ['secondary', rateLimits.secondary]].filter(([, value]) => value).map(([name, value]) => {
    const percent = clamp(Number(value.used_percent) || 0, 0, 100);
    const minutes = Number(value.window_minutes);
    const label = minutes === 300 ? '5 小时窗口' : minutes === 10080 ? '7 天窗口' : `${formatDuration(minutes * 60_000)}窗口`;
    const reset = value.resets_at ? toMs(value.resets_at) : null;
    return `<article class="subscription-card"><p class="eyebrow">${escapeHtml(name.toUpperCase())}</p><div class="value-row"><h3>${escapeHtml(label)}</h3><strong>${percent.toFixed(0)}%</strong></div><progress max="100" value="${percent}"></progress><p class="muted">${reset ? `重置于 ${formatDate(reset)}` : '重置时间未提供'}</p></article>`;
  });
  if (rateLimits.credits) cards.push(`<article class="subscription-card"><p class="eyebrow">CREDITS</p><div class="value-row"><h3>额外额度</h3><strong>${escapeHtml(rateLimits.credits.unlimited ? '不限量' : rateLimits.credits.balance ?? '0')}</strong></div><p class="muted">${rateLimits.credits.has_credits ? '当前有可用 credits' : '当前无额外 credits'}</p></article>`);
  container.innerHTML = cards.join('');
}

function toMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : null;
}

function renderOverview(data) {
  const value = data.overview;
  renderKpis('#overview-kpis', [
    ['完成率', formatPercent(value.completionRate), `${value.completed} 完成 · ${data.reliability.aborted} 中止 · ${data.reliability.incomplete} 不完整`, value.completionRate !== null && value.completionRate < .8 ? 'danger' : ''],
    ['耗时 P50', formatDuration(value.durationP50), `P95 ${formatDuration(value.durationP95)}`],
    ['TTFT P50', formatDuration(value.ttftP50), '首个响应阶段'],
    ['总 Token', formatTokens(value.totalTokens), `推理占比 ${formatPercent(value.reasoningShare)}`],
    ['缓存命中', formatPercent(value.cacheHitRate), '缓存输入 ÷ 输入 Token'],
    ['上下文风险', String(value.contextWarning + value.contextDanger), `${value.contextWarning} 预警 · ${value.contextDanger} 危险`, value.contextDanger ? 'danger' : value.contextWarning ? 'warning' : ''],
    ['当前并发', String(value.currentConcurrency), `峰值 ${value.peakConcurrency}`],
    ['上下文压缩', String(value.compactions), '已识别压缩阶段'],
  ]);
  renderLatencyChart(state.summary.trend);
  renderConcurrency(data.concurrency);
  renderWorkModes(data.workModes, data.coverage);
  renderReliability(data.reliability);
}

function renderLatencyChart(trend) {
  const container = $('#latency-chart');
  const rows = trend.filter((entry) => Number.isFinite(entry.durationMs)).slice(-36);
  if (!rows.length) { container.innerHTML = empty('没有完整的耗时数据'); return; }
  const max = Math.max(...rows.map((entry) => entry.durationMs), 1);
  const keys = ['receive', 'reasoning', 'tool', 'commentary', 'final', 'other'];
  container.innerHTML = `<div class="timeline-bars">${rows.map((entry) => `<div class="timeline-row" title="${escapeHtml(`${entry.title} · ${formatDuration(entry.durationMs)}`)}"><span>${escapeHtml(formatDate(entry.receivedAtMs, false))}</span><div class="stacked-track" style="width:${Math.max(4, entry.durationMs / max * 100)}%">${keys.map((key) => `<i class="bar-${key}" style="width:${entry.durationMs ? (entry.stageDurations[key] || 0) / entry.durationMs * 100 : 0}%"></i>`).join('')}</div></div>`).join('')}</div>`;
  $('#latency-legend').innerHTML = keys.map((key) => `<span><i class="swatch ${key}"></i>${escapeHtml(stageLabel(key))}</span>`).join('');
}

function renderConcurrency(concurrency) {
  $('#concurrency-summary').textContent = `峰值 ${concurrency.peak} · 重叠 ${formatPercent(concurrency.parallelTurnPercent)}`;
  const rows = concurrency.timeline.slice(-80);
  if (!rows.length) { $('#concurrency-chart').innerHTML = empty('没有可用的轮次区间'); return; }
  const max = Math.max(concurrency.peak, 1);
  $('#concurrency-chart').innerHTML = `<div class="column-chart">${rows.map((entry) => `<i style="height:${Math.max(3, entry.value / max * 100)}%" title="${escapeHtml(`${formatDate(entry.at)} · ${entry.value} 个并发任务`)}"></i>`).join('')}</div>`;
}

function renderBarList(rows, key, label) {
  if (!rows.length) return empty('Codex 未提供');
  const max = Math.max(...rows.map((entry) => entry[key]), 1);
  return `<div class="bar-list">${rows.map((entry) => `<div class="bar-list-row"><span>${escapeHtml(label(entry))}</span><div><i style="width:${entry[key] / max * 100}%"></i></div><strong>${escapeHtml(entry[key])}</strong></div>`).join('')}</div>`;
}

function renderWorkModes(workModes, coverage) {
  $('#work-modes').innerHTML = renderBarList(workModes.modes, 'count', (entry) => modeLabel(entry.mode));
  if (!coverage.workModes) $('#work-modes').innerHTML += '<p class="coverage-note">当前日志没有明确工作模式字段，数据归入“Codex 未提供”，未根据标题或目录猜测。</p>';
  if (workModes.automations.length) $('#work-modes').innerHTML += `<h3 class="subheading">自动化类型</h3>${renderBarList(workModes.automations, 'count', (entry) => entry.kind)}`;
  else $('#work-modes').innerHTML += '<div class="empty-state compact spaced">Codex 未提供自动化元数据</div>';
}

function renderReliability(value) {
  const total = value.completed + value.aborted + value.incomplete;
  $('#reliability').innerHTML = `<div class="health-ring" style="--value:${(value.completionRate || 0) * 360}deg"><div><strong>${formatPercent(value.completionRate, 0)}</strong><span>完成率</span></div></div><div class="reliability-grid"><span><strong>${value.completed}</strong>已完成</span><span><strong>${value.aborted}</strong>已中止</span><span><strong>${value.incomplete}</strong>不完整</span><span><strong>${value.toolFailures}</strong>工具失败</span></div>${total ? '' : empty('没有终态轮次')}`;
}

function renderEfficiency(data) {
  renderKpis('#efficiency-kpis', [
    ['模型组合', String(data.efficiency.matrix.length), '模型 × 推理强度'],
    ['缓存输入', formatTokens(data.cache.cachedInputTokens), `命中率 ${formatPercent(data.cache.hitRate)}`],
    ['缓存写入', formatTokens(data.cache.cacheWriteInputTokens), `占输入 ${formatPercent(data.cache.writeRate)}`],
    ['推理占比', formatPercent(data.overview.reasoningShare), '推理输出 ÷ 输出 Token'],
  ]);
  const matrix = data.efficiency.matrix;
  $('#efficiency-matrix').innerHTML = matrix.length ? `<div class="table-scroll"><table class="event-table"><thead><tr><th>模型</th><th>推理强度</th><th>轮次</th><th>完成率</th><th>P50</th><th>P95</th><th>TTFT P50</th><th>平均 Token</th><th>缓存命中</th><th>推理占比</th></tr></thead><tbody>${matrix.map((row) => `<tr><td><strong>${escapeHtml(row.model)}</strong></td><td>${escapeHtml(row.effort === 'unknown' ? 'Codex 未提供' : row.effort)}</td><td>${row.turns}</td><td>${formatPercent(row.completionRate)}</td><td>${formatDuration(row.durationP50)}</td><td>${formatDuration(row.durationP95)}</td><td>${formatDuration(row.ttftP50)}</td><td>${formatTokens(row.averageTokens)}</td><td>${formatPercent(row.cacheHitRate)}</td><td>${formatPercent(row.reasoningShare)}</td></tr>`).join('')}</tbody></table></div>` : empty('没有可比较的模型数据');
  const trend = data.cache.trend.slice(-48);
  const max = Math.max(...trend.map((entry) => entry.inputTokens + entry.cacheWriteInputTokens), 1);
  $('#cache-chart').innerHTML = trend.length ? `<div class="column-chart cache">${trend.map((entry) => {
    const cached = Math.min(entry.cachedInputTokens, entry.inputTokens);
    const uncached = Math.max(0, entry.inputTokens - cached);
    return `<div style="height:${Math.max(3, (entry.inputTokens + entry.cacheWriteInputTokens) / max * 100)}%" title="${escapeHtml(`${entry.title} · 缓存 ${formatTokens(cached)} · 未缓存 ${formatTokens(uncached)} · 写入 ${formatTokens(entry.cacheWriteInputTokens)}`)}"><i class="uncached" style="height:${entry.inputTokens ? uncached / (entry.inputTokens + entry.cacheWriteInputTokens) * 100 : 0}%"></i><i class="cached" style="height:${entry.inputTokens ? cached / (entry.inputTokens + entry.cacheWriteInputTokens) * 100 : 0}%"></i><i class="write" style="height:${entry.cacheWriteInputTokens / Math.max(1, entry.inputTokens + entry.cacheWriteInputTokens) * 100}%"></i></div>`;
  }).join('')}</div><div class="legend"><span><i class="swatch uncached"></i>未缓存输入</span><span><i class="swatch cached"></i>缓存输入</span><span><i class="swatch write"></i>缓存写入</span></div>` : empty('没有缓存 Token 数据');
  $('#cache-summary').innerHTML = `<div class="metric-stack"><div><span>输入 Token</span><strong>${formatTokens(data.cache.inputTokens)}</strong></div><div><span>缓存输入</span><strong>${formatTokens(data.cache.cachedInputTokens)}</strong></div><div><span>缓存写入</span><strong>${formatTokens(data.cache.cacheWriteInputTokens)}</strong></div><div><span>命中率</span><strong>${formatPercent(data.cache.hitRate)}</strong></div></div>`;
}

function renderTools(data) {
  const tools = data.tools;
  renderKpis('#tool-kpis', [
    ['工具调用', String(tools.calls), `${tools.groups.length} 个工具`],
    ['累计工具时长', formatDuration(tools.totalDurationMs), '可能包含并行重叠'],
    ['工具失败', String(tools.failures), `失败率 ${formatPercent(tools.failureRate)}`, tools.failures ? 'danger' : ''],
    ['子智能体', String(data.agents.count), `${data.agents.calls} 个活动阶段`],
  ]);
  $('#tool-table').innerHTML = tools.groups.length ? `<div class="table-scroll"><table class="event-table"><thead><tr><th>类别</th><th>工具</th><th>调用</th><th>累计耗时</th><th>P95</th><th>失败</th><th>失败率</th></tr></thead><tbody>${tools.groups.map((row) => `<tr><td>${escapeHtml(categoryLabel(row.category))}</td><td><strong>${escapeHtml(row.name)}</strong></td><td>${row.calls}</td><td>${formatDuration(row.totalDurationMs)}</td><td>${formatDuration(row.durationP95)}</td><td>${row.failures}</td><td>${formatPercent(row.failureRate)}</td></tr>`).join('')}</tbody></table></div>` : empty('没有工具阶段数据');
  if (!data.coverage.agents) {
    $('#agent-health').innerHTML = empty('Codex 未提供可关联的智能体标识；不会根据任务标题推测父子关系。');
    return;
  }
  const agent = data.agents;
  $('#agent-health').innerHTML = `<div class="detail-grid"><div class="detail-tile"><span>匿名智能体</span><strong>${agent.count}</strong></div><div class="detail-tile"><span>活动阶段</span><strong>${agent.calls}</strong></div><div class="detail-tile"><span>累计耗时</span><strong>${formatDuration(agent.combinedDurationMs)}</strong></div><div class="detail-tile"><span>墙钟跨度</span><strong>${formatDuration(agent.wallClockMs)}</strong></div><div class="detail-tile"><span>并行重叠率</span><strong>${formatPercent(agent.overlapPercent)}</strong></div><div class="detail-tile"><span>父子关系</span><strong>${agent.relations.length}</strong></div></div>${agent.timeline.length ? `<div class="table-scroll"><table class="event-table"><thead><tr><th>任务</th><th>智能体</th><th>父智能体</th><th>开始</th><th>耗时</th><th>状态</th></tr></thead><tbody>${agent.timeline.map((row) => `<tr><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.agentId || '—')}</td><td>${escapeHtml(row.parentAgentId || '—')}</td><td>${formatDate(row.startedAtMs)}</td><td>${formatDuration(row.durationMs)}</td><td>${escapeHtml(statusLabel(row.status))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function renderContext(data) {
  const context = data.context;
  renderKpis('#context-kpis', [
    ['峰值 P50', formatContextPercent(context.peakP50), '轮次上下文峰值'],
    ['峰值 P95', formatContextPercent(context.peakP95), '轮次上下文峰值'],
    ['预警轮次', String(context.warning), '70%–84.9%', context.warning ? 'warning' : ''],
    ['危险轮次', String(context.danger), '≥ 85%', context.danger ? 'danger' : ''],
    ['压缩次数', String(context.compactions), `累计 ${formatDuration(context.compactionDurationMs)}`],
  ]);
  const trend = context.trend.filter((entry) => Number.isFinite(entry.peakPercent)).slice(-80);
  $('#context-chart').innerHTML = trend.length ? `<div class="column-chart context">${trend.map((entry) => `<i class="${entry.peakPercent >= 85 ? 'danger' : entry.peakPercent >= 70 ? 'warning' : ''}" style="height:${Math.max(3, clamp(entry.peakPercent, 0, 100))}%" title="${escapeHtml(`${entry.title} · 峰值 ${entry.peakPercent.toFixed(1)}%${entry.compacted ? ' · 已压缩' : ''}`)}"></i>`).join('')}</div><div class="threshold-labels"><span>70% 预警</span><span>85% 危险</span></div>` : empty('Codex 未提供上下文窗口数据');
  $('#compaction-summary').innerHTML = context.compactions ? `<div class="metric-stack"><div><span>压缩次数</span><strong>${context.compactions}</strong></div><div><span>累计压缩耗时</span><strong>${formatDuration(context.compactionDurationMs)}</strong></div><div><span>平均压缩耗时</span><strong>${formatDuration(context.compactionDurationMs / context.compactions)}</strong></div></div>` : empty('没有识别到上下文压缩阶段');
}

function renderTasks(tasks) {
  $('#task-count').textContent = `${tasks.length} 个任务`;
  $('#task-list').innerHTML = tasks.length ? tasks.map((task) => {
    const open = state.openTask === task.threadId;
    return `<article class="task-card ${open ? 'open' : ''}"><button class="task-summary" type="button" data-action="toggle-task" data-thread="${escapeHtml(task.threadId)}"><div><h3 class="task-title">${escapeHtml(task.title)}</h3><p class="task-path" title="${escapeHtml(task.cwd || '')}">${escapeHtml(task.project)} · ${escapeHtml(task.modes.length ? task.modes.map(modeLabel).join(' / ') : '工作模式未知')}</p></div><div class="metric-mini"><strong>${task.turns.length}</strong>轮次</div><div class="metric-mini hide-small"><strong>${formatPercent(task.completionRate)}</strong>完成率</div><div class="metric-mini hide-medium"><strong>${formatTokens(task.totalTokens)}</strong>Token</div><div class="metric-mini hide-medium"><strong>${task.toolCalls}</strong>工具 · ${task.toolFailures} 失败</div><span class="chevron">›</span></button>${open ? `<div class="turns">${renderTurnRows(state.taskTurns.get(task.threadId), state.taskTurnErrors.get(task.threadId))}</div>` : ''}</article>`;
  }).join('') : empty('当前筛选条件下没有任务');
}

function renderTurnRows(cacheEntry, error) {
  if (!cacheEntry && error) return empty('轮次载入失败，请折叠后重试');
  if (!cacheEntry) return empty('正在载入轮次…');
  const { turns } = cacheEntry;
  if (!turns.length) return empty('没有轮次');
  return turns.map((turn) => `<div class="turn-row" role="button" tabindex="0" data-action="open-turn" data-thread="${escapeHtml(turn.threadId)}" data-turn="${escapeHtml(turn.turnId)}"><div><span class="badge ${escapeHtml(turn.status)}">${escapeHtml(statusLabel(turn.status))}</span><p class="task-path">${escapeHtml(formatDate(turn.receivedAtMs, false))}</p></div><div class="excerpt"><p>${escapeHtml(turn.userExcerpt || '用户消息未提供')}</p><p class="answer">${escapeHtml(turn.assistantExcerpt || '最终回复未提供')}</p></div><div class="metric-mini"><strong>${formatDuration(turn.durationMs)}</strong>耗时</div><div class="metric-mini hide-small"><strong>${formatTokens(turn.tokens.total)}</strong>Token</div><div class="metric-mini hide-medium"><strong>${formatContextPercent(turn.context.latestPercent)}</strong>上下文</div><div class="metric-mini hide-medium"><strong>${turn.toolSummary.calls}</strong>工具</div></div>`).join('');
}

function invalidateTaskTurns({ collapse = true } = {}) {
  state.filterGeneration += 1;
  state.taskTurns.clear();
  state.taskTurnErrors.clear();
  state.taskTurnRequests.clear();
  if (collapse) state.openTask = null;
}

async function loadTaskTurns(threadId) {
  if (!threadId) return null;
  const existingRequest = state.taskTurnRequests.get(threadId);
  if (existingRequest) return existingRequest;
  const generation = state.filterGeneration;
  const task = state.tasks.find((entry) => entry.threadId === threadId);
  const revision = taskRevision(task);
  const cached = state.taskTurns.get(threadId);
  if (cached && cached.revision === revision) return cached.turns;
  state.taskTurnErrors.delete(threadId);
  let applied = false;
  const request = api(`/api/tasks/${encodeURIComponent(threadId)}/turns?${queryString()}`)
    .then((payload) => {
      if (generation !== state.filterGeneration) return null;
      state.taskTurns.set(threadId, { revision, turns: payload.turns });
      applied = true;
      state.taskTurnErrors.delete(threadId);
      if (state.openTask === threadId) renderTasks(state.tasks);
      return payload.turns;
    })
    .catch((error) => {
      if (generation !== state.filterGeneration) return null;
      if (!cached) state.taskTurnErrors.set(threadId, error.message);
      showError(`${cached ? '无法刷新' : '无法读取'}任务轮次：${error.message}`);
      if (state.openTask === threadId) renderTasks(state.tasks);
      return null;
    })
    .finally(() => {
      if (state.taskTurnRequests.get(threadId) === request) state.taskTurnRequests.delete(threadId);
      const latestTask = state.tasks.find((entry) => entry.threadId === threadId);
      if (applied && state.openTask === threadId && taskCacheNeedsRefresh(state.taskTurns.get(threadId), latestTask)) {
        queueMicrotask(() => loadTaskTurns(threadId));
      }
    });
  state.taskTurnRequests.set(threadId, request);
  return request;
}

async function toggleTask(threadId) {
  if (state.openTask === threadId) { state.openTask = null; renderTasks(state.tasks); return; }
  state.openTask = threadId;
  state.taskTurnErrors.delete(threadId);
  renderTasks(state.tasks);
  await loadTaskTurns(threadId);
}

async function openTurn(threadId, turnId) {
  if (!state.taskTurns.has(threadId)) await loadTaskTurns(threadId);
  const turn = state.taskTurns.get(threadId)?.turns.find((entry) => entry.turnId === turnId);
  if (!turn) return;
  $('#dialog-title').textContent = turn.title;
  $('#dialog-body').innerHTML = renderTurnDetails(turn);
  $('#turn-dialog').showModal();
}

function renderTurnDetails(turn) {
  const details = [
    ['状态', statusLabel(turn.status)], ['模型', `${turn.model}${turn.effort ? ` · ${turn.effort}` : ''}`],
    ['工作模式', modeLabel(turn.dimensions.executionMode || 'unknown')], ['速度', turn.dimensions.speed || 'Codex 未提供'],
    ['推理模式', turn.dimensions.reasoningMode || 'Codex 未提供'], ['总耗时', formatDuration(turn.durationMs)],
    ['TTFT', `${formatDuration(turn.ttftMs)}${turn.ttftProvisional ? '（估算）' : ''}`], ['总 Token', formatTokens(turn.tokens.total)],
    ['缓存输入', formatTokens(turn.tokens.cachedInput)], ['缓存写入', formatTokens(turn.tokens.cacheWriteInput)],
    ['推理 Token', formatTokens(turn.tokens.reasoningOutput)], ['工具调用', `${turn.toolSummary.calls} 次 · ${turn.toolSummary.failures} 失败`],
    ['上下文', formatContextPercent(turn.context.latestPercent)], ['上下文峰值', `${formatContextPercent(turn.context.peakPercent)}${turn.context.compacted ? ' · 已压缩' : ''}`],
  ];
  return `<div class="detail-grid">${details.map(([label, value]) => `<div class="detail-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>${turn.userExcerpt ? `<h3 class="subheading">用户消息摘录</h3><div class="message-box">${escapeHtml(turn.userExcerpt)}</div>` : ''}${turn.assistantExcerpt ? `<h3 class="subheading">最终回复摘录</h3><div class="message-box">${escapeHtml(turn.assistantExcerpt)}</div>` : ''}<h3 class="subheading">阶段瀑布</h3>${renderWaterfall(turn)}<h3 class="subheading">阶段事件</h3>${renderStageTable(turn.stages)}<h3 class="subheading">Token 快照</h3>${renderUsageTable(turn.usageEvents)}`;
}

function renderWaterfall(turn) {
  const timeline = waterfallTimeline(turn);
  if (!timeline) return empty('没有足够的时间戳数据');
  const ticks = [0, .25, .5, .75, 1];
  const chartWidth = 1000;
  const trackLeft = 120;
  const trackWidth = chartWidth - trackLeft - 12;
  const axisY = 18;
  const rowHeight = 26;
  const firstRowY = 32;
  const chartHeight = firstRowY + timeline.stages.length * rowHeight + 8;
  const gridLines = ticks.map((ratio) => {
    const x = trackLeft + ratio * trackWidth;
    return `<line class="waterfall-grid-line" x1="${x}" x2="${x}" y1="${firstRowY - 4}" y2="${chartHeight - 8}"></line><text class="waterfall-axis-label" x="${x}" y="${axisY}" text-anchor="${ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}">${escapeHtml(formatDuration(timeline.durationMs * ratio))}</text>`;
  }).join('');
  const rows = timeline.stages.map(({ stage, left, width }, index) => {
    const y = firstRowY + index * rowHeight;
    const x = trackLeft + left / 100 * trackWidth;
    const barWidth = Math.max(2, width / 100 * trackWidth);
    return `<text class="waterfall-label" x="0" y="${y + 11}">${escapeHtml(stageLabel(stage.kind))}</text><rect class="waterfall-track-svg" x="${trackLeft}" y="${y}" width="${trackWidth}" height="14" rx="4"></rect><rect class="waterfall-bar bar-${escapeHtml(stage.kind)}" x="${x.toFixed(2)}" y="${y}" width="${barWidth.toFixed(2)}" height="14" rx="4"><title>${escapeHtml(`${stage.rawType} · ${formatDuration(stage.durationMs)}`)}</title></rect>`;
  }).join('');
  return `<div class="waterfall"><svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="阶段时间瀑布">${gridLines}${rows}</svg></div>`;
}

function renderStageTable(stages) {
  if (!stages.length) return empty('没有阶段事件');
  return `<div class="table-scroll"><table class="event-table"><thead><tr><th>阶段</th><th>原始类型</th><th>安全工具信息</th><th>状态</th><th>开始</th><th>耗时</th></tr></thead><tbody>${stages.map((stage) => `<tr><td>${escapeHtml(stageLabel(stage.kind))}</td><td>${escapeHtml(stage.rawType)}</td><td>${escapeHtml(stage.metadata.toolName || '—')}</td><td>${escapeHtml(statusLabel(stage.metadata.toolStatus || stage.status || 'unknown'))}</td><td>${escapeHtml(formatDate(stage.startedAtMs))}</td><td>${escapeHtml(formatDuration(stage.durationMs))}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderUsageTable(events) {
  if (!events.length) return empty('Codex 未提供 Token 快照');
  return `<div class="table-scroll"><table class="event-table"><thead><tr><th>时间</th><th>输入</th><th>缓存</th><th>缓存写入</th><th>输出</th><th>推理</th><th>总计</th><th>上下文</th></tr></thead><tbody>${events.map((event) => `<tr><td>${escapeHtml(formatDate(event.timestampMs))}</td><td>${formatTokens(event.tokens.input)}</td><td>${formatTokens(event.tokens.cachedInput)}</td><td>${formatTokens(event.tokens.cacheWriteInput)}</td><td>${formatTokens(event.tokens.output)}</td><td>${formatTokens(event.tokens.reasoningOutput)}</td><td>${formatTokens(event.tokens.total)}</td><td>${event.context.input && event.context.window ? `${(event.context.input / event.context.window * 100).toFixed(1)}%` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderDiagnostics(rows) {
  $('#diagnostic-count').textContent = String(rows.length);
  $('#diagnostics-content').innerHTML = rows.length ? rows.map((row) => `<div class="diagnostic-row"><span>${escapeHtml(row.event_type)}</span><span>${escapeHtml(row.event_count)} 次 · ${escapeHtml(formatDate(row.last_seen_ms))}</span></div>`).join('') : '<p class="muted">没有未知事件。</p>';
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
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
        for (const message of messages) if (message.includes('event: refresh') || message.includes('event: diagnostic')) scheduleRefresh();
      }
    } catch {
      connection('offline', '正在重连');
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => loadDashboard({ quiet: true }), 250);
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) return switchTab(tab.dataset.tab);
  const action = event.target.closest('[data-action]');
  if (action?.dataset.action === 'toggle-task') return toggleTask(action.dataset.thread);
  if (action?.dataset.action === 'open-turn') return openTurn(action.dataset.thread, action.dataset.turn);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const target = event.target.closest('[data-action="open-turn"]');
  if (target) openTurn(target.dataset.thread, target.dataset.turn);
});

for (const [selector, key] of [['#range-filter', 'range'], ['#project-filter', 'project'], ['#model-filter', 'model'], ['#effort-filter', 'effort'], ['#status-filter', 'status'], ['#mode-filter', 'mode']]) {
  $(selector).addEventListener('change', (event) => { state.filters[key] = event.target.value; invalidateTaskTurns(); loadDashboard(); });
}

$('#close-dialog').addEventListener('click', () => $('#turn-dialog').close());
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('这会清除已完成轮次的本地指标缓存，但不会删除 Codex 原始日志。继续吗？')) return;
  if (!confirm('请再次确认：清空后将从下一轮继续采集；如需恢复历史，可使用“重新导入”。')) return;
  try { await api('/api/history/clear', { method: 'POST', body: JSON.stringify({ confirm: 'CLEAR_METRICS' }) }); invalidateTaskTurns(); await loadDashboard(); }
  catch (error) { showError(`清空失败：${error.message}`); }
});

$('#reimport').addEventListener('click', async () => {
  if (!confirm('将从 Codex 原始日志重新构建全部指标，期间数据会逐步出现。继续吗？')) return;
  try { await api('/api/history/reimport', { method: 'POST', body: JSON.stringify({ confirm: 'REIMPORT_ALL' }) }); invalidateTaskTurns(); await loadDashboard(); }
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
