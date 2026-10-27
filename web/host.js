'use strict';
const $ = id => document.getElementById(id);
const STORE = 'ai-kp.host.tab.v1';
let saved = {};
try { saved = JSON.parse(sessionStorage.getItem(STORE) || '{}'); } catch { saved = {}; }
let token = saved.token || '', room = null, config = null, materials = [], rooms = [], busy = false;
let currentPlayer = saved.playerId || '', pending = null, pendingStart = null, pendingQq = null;
const drafts = saved.drafts || {};
const submissions = saved.submissions || {};
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const option = (value, text) => { const n = node('option', '', text); n.value = value; return n; };
function remember() {
  if (room) submissions[room.id] = { message: pending, start: pendingStart, qq: pendingQq };
  try { sessionStorage.setItem(STORE, JSON.stringify({ token, roomId: room?.id || saved.roomId || '', playerId: currentPlayer, drafts, submissions })); return true; }
  catch { notice('浏览器不允许保存标签页状态；为避免重载后重复提交，本次请求未发送。请允许会话存储后重试。'); return false; }
}
function persistBeforeRequest() { if (!saveDraft()) throw new Error('未能保存本次消息 ID，请求未发送。'); }
function roomDraft(id) { const value = drafts[id]; return typeof value === 'string' ? { text: value, kind: 'dialogue' } : value || { text: '', kind: 'dialogue' }; }
function notice(text, success = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').className = success ? 'success' : ''; }
function readable(error) { return `${error.message || '请求失败'}${error.code ? `（${error.code}）` : ''}`; }
async function api(path, body) {
  if (!token) throw new Error('请先输入本机管理令牌并读取工作台。');
  let response;
  try { response = await fetch(`/api/host${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', 'X-Admin-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { $('connection').textContent = '本地服务不可达'; $('connection').className = 'badge bad'; throw new Error('无法连接本地服务器。请检查服务是否运行；输入已保留，可重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务器响应不是有效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) { const error = new Error(data.error?.message || (typeof data.error === 'string' ? data.error : `请求失败：HTTP ${response.status}`)); error.code = data.error?.code || data.code; throw error; }
  $('connection').textContent = '本地服务已连接'; $('connection').className = 'badge good'; return data;
}
async function run(task) {
  if (busy) return;
  busy = true; notice(''); enabled();
  try { await task(); } catch (error) { notice(readable(error)); }
  finally { busy = false; enabled(); }
}
function enabled() {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  const active = Boolean(room) && !busy && !room.busy && !room.processing;
  for (const id of ['start-room', 'send-message']) $(id).disabled = !active;
  $('message-text').disabled = !room || busy;
  $('current-player').disabled = !room || busy;
  $('message-kind').disabled = !room || busy;
  $('qq-bind-form').querySelector('button').disabled = !active;
  $('qq-sim-form').querySelector('button').disabled = !active;
  $('refresh-room').disabled = busy || !token;
  $('test-api').disabled = busy || !config;
  $('busy-state').textContent = busy || room?.busy || room?.processing ? '主持人处理中，请稍候…' : room ? '准备接收下一句话' : '尚未开团';
  $('send-message').textContent = busy ? '处理中…' : '发送 →';
  $('message-form').setAttribute('aria-busy', String(busy));
}
function providers() { return Array.isArray(config?.providers) ? config.providers : Object.entries(config?.providers || {}).map(([id, item]) => ({ id, ...item })); }
function providerLabel(item) { return ({ anthropic: 'Claude / Anthropic', openai: 'OpenAI', gemini: 'Google / Gemini', demo: '固定脚本 · 离线协议演示' })[item.id] || item.id; }
function renderConfig() {
  const selected = $('api-provider').value;
  const list = providers().filter(p => p.id !== 'demo');
  for (const p of list) if (![...$('api-provider').options].some(o => o.value === p.id)) $('api-provider').append(option(p.id, providerLabel(p)));
  if (list.some(p => p.id === selected)) $('api-provider').value = selected;
  const previous = $('room-provider').value;
  $('room-provider').replaceChildren(option('demo', '固定脚本 · 离线协议演示'));
  for (const p of list) { const opt = option(p.id, `${providerLabel(p)} · ${p.configured ? '已存密钥 / 尚未验证' : '未配置密钥'}`); opt.disabled = !p.configured; $('room-provider').append(opt); }
  if ([...$('room-provider').options].some(o => o.value === previous && !o.disabled)) $('room-provider').value = previous;
  $('provider-summary').textContent = `${list.filter(p => p.configured).length} 家已存凭证 · 连接请单独测试`;
  fillProvider();
  const qq = config?.qq || {};
  $('qq-url').value = qq.apiBaseUrl || '';
  $('qq-enabled').checked = Boolean(qq.enabled);
  $('qq-callback').value = new URL(qq.callbackPath || '/api/host/qq/events', location.origin).href;
  $('qq-config-state').textContent = `${qq.enabled ? '真实桥接已启用' : '真实桥接未启用'} · Token ${qq.accessTokenConfigured ? '已存' : '未存'} · Secret ${qq.secretConfigured ? '已存' : '未存'} · 真实账号待联调`;
}
function fillProvider() {
  const p = providers().find(p => p.id === $('api-provider').value);
  $('api-model').value = p?.model || '';
  $('api-base').value = p?.baseUrl || '';
  $('api-key').value = ''; $('delete-key').checked = false;
  $('key-state').textContent = p?.configured ? '（服务器已有密钥）' : '（未配置）';
  $('test-result').textContent = '未测试；保存配置不代表已连接模型。';
}
function renderMaterials() {
  $('material-count').textContent = `${materials.length} 份素材`;
  for (const [kind, id, label] of [['rules', 'rules-id', '内置原创示例规则'], ['scenario', 'scenario-id', '内置原创示例剧本']]) {
    const previous = $(id).value;
    $(id).replaceChildren(option('', label));
    for (const m of materials.filter(m => m.kind === kind)) $(id).append(option(m.id, m.title || m.id));
    if ([...$(id).options].some(o => o.value === previous)) $(id).value = previous;
  }
}
function renderRooms() {
  $('room-select').replaceChildren(option('', '选择服务器上的团'));
  for (const r of rooms) $('room-select').append(option(r.id, `${r.name || r.id}${r.provider === 'demo' ? ' · 离线演示' : ''}`));
  if (room) $('room-select').value = room.id;
}
function addPlayer(name = '', id = `player-${$('players-edit').children.length + 1}`) {
  const row = node('div', 'player-edit');
  const identity = node('label', '', '玩家 ID / QQ 用户 ID'); const ident = node('input'); ident.value = id; ident.required = true; ident.maxLength = 80; ident.dataset.field = 'id'; identity.append(ident);
  const label = node('label', '', '玩家名称'); const input = node('input'); input.value = name; input.required = true; input.maxLength = 80; input.placeholder = '输入角色 / 玩家名'; input.dataset.field = 'name'; label.append(input);
  const remove = node('button', '', '移除'); remove.type = 'button'; remove.addEventListener('click', () => { if ($('players-edit').children.length <= 2) return notice('请保留至少两位玩家，用于多人群聊。'); row.remove(); });
  row.append(identity, label, remove); $('players-edit').append(row);
}
function primitive(value) { if (value === null || value === undefined) return ''; return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }
function record(container, title, text) { const item = node('div', 'record-row'); if (title) item.append(node('strong', 'record-title', title)); item.append(node('div', '', primitive(text))); container.append(item); }
function renderMemory() {
  const memory = room.memory || {};
  $('memory').replaceChildren();
  if (typeof memory === 'string') record($('memory'), '', memory);
  else for (const [key, title] of [['mainQuest', '主线'], ['sideQuests', '支线'], ['facts', '已知事实'], ['npcs', '已知人物'], ['pace', '当前节奏']]) {
    const value = memory[key]; if (!value || (Array.isArray(value) && !value.length)) continue;
    record($('memory'), title, Array.isArray(value) ? value.map(primitive).join('\n') : value);
  }
  if (!$('memory').childNodes.length) $('memory').textContent = '暂无公开记忆，等待主持人续写。';
  $('gm-notes').replaceChildren();
  const notes = room.gmNotes;
  if (Array.isArray(notes)) for (const n of notes) record($('gm-notes'), n.title || '', n.text || n.note || n);
  else if (notes) record($('gm-notes'), '', notes);
  if (!$('gm-notes').childNodes.length) $('gm-notes').textContent = '暂无主持私密笔记。仅管理台可见。';
}
function renderEvents() {
  const el = $('events'), nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 110;
  el.replaceChildren();
  for (const event of room.events || []) {
    const isKp = ['kp', 'assistant', 'narration'].includes(event.type || event.role);
    const isPlayer = event.type === 'player' || event.role === 'user';
    const author = isKp ? '主持人' : isPlayer ? room.players?.find(p => p.id === event.playerId)?.name || event.nickname || event.playerId || '玩家' : event.type === 'error' ? '处理失败' : '系统';
    const item = node('article', `message ${isKp ? 'kp' : isPlayer ? 'player' : 'system'}`);
    item.append(node('div', 'avatar', isKp ? 'KP' : author.slice(0, 1)));
    const main = node('div', 'message-main'), meta = node('div', 'message-meta');
    meta.append(node('span', 'message-author', author));
    const kind = { dialogue: '对话', action: '行动', ooc: '题外话' }[event.kind];
    if (kind) meta.append(node('span', '', kind));
    if (event.at || event.createdAt) { const date = new Date(event.at || event.createdAt); if (!Number.isNaN(date.getTime())) meta.append(node('time', '', date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))); }
    main.append(meta, node('div', 'bubble', event.text || event.message || '')); item.append(main); el.append(item);
  }
  if (!el.children.length) { const empty = node('div', 'empty'); empty.append(node('span', '', '✧'), node('h3', '', '同行的人已到齐。'), node('p', '', '点击「请主持人开场」，或直接发出第一条消息。')); el.append(empty); }
  if (nearBottom || !el.dataset.loaded) el.scrollTop = el.scrollHeight;
  el.dataset.loaded = 'true';
}
function renderRoom(next) {
  const switched = room?.id !== next.id;
  if (room && switched) saveDraft();
  room = next; saved.roomId = room.id;
  $('current-room-name').textContent = room.name || room.id;
  $('room-meta').textContent = `${room.provider === 'demo' ? '固定脚本离线演示' : `${room.provider} · 真实模型需连接测试`} · ${(room.players || []).length} 位玩家 · ${room.id}`;
  $('demo-banner').hidden = room.provider !== 'demo';
  const draft = roomDraft(room.id);
  const previous = switched ? draft.playerId || saved.playerId : $('current-player').value;
  $('current-player').replaceChildren(...(room.players || []).map(p => option(p.id, p.name || p.id)));
  currentPlayer = room.players?.some(p => p.id === previous) ? previous : room.players?.[0]?.id || '';
  $('current-player').value = currentPlayer;
  if (switched) {
    const inFlight = submissions[room.id] || {};
    pending = inFlight.message || null; pendingStart = inFlight.start || null; pendingQq = inFlight.qq || null;
    $('message-text').value = draft.text || '';
    $('message-kind').value = ['dialogue', 'action', 'ooc'].includes(draft.kind) ? draft.kind : 'dialogue';
    $('events').dataset.loaded = '';
  }
  const lastError = [...(room.events || [])].reverse().find(e => e.type === 'error');
  const lastReceipt = Object.values(room.receipts || {}).at(-1);
  $('room-error').hidden = !lastError || lastReceipt?.status === 'complete';
  $('room-error').textContent = lastError?.text || '';
  renderEvents(); renderMemory();
  $('rolls').replaceChildren();
  for (const r of room.rolls || []) { const item = node('div', 'record-row'); item.append(node('strong', 'roll-expression', `${r.expression} → ${r.total ?? r.result ?? '?'}`)); item.append(node('div', '', `${(r.values || r.rolls || []).join(', ')}${r.reason ? ` · ${r.reason}` : ''}`)); $('rolls').append(item); }
  if (!$('rolls').children.length) $('rolls').textContent = '尚无骰点。由模型决定何时请求 RD，服务器实际掷骰。';
  $('tools').replaceChildren();
  for (const t of room.toolCalls || room.tools || []) record($('tools'), t.name || t.tool || '工具', t.status || '已处理');
  if (!$('tools').children.length) $('tools').textContent = `${(room.rolls || []).length} 次服务端掷骰已记录。原始工具参数不在群聊展示。`;
  $('qq-bound').textContent = room.qq?.groupId ? `已绑定群 ${room.qq.groupId} · ${room.qq.mode === 'all' ? '所有消息' : '仅 @ 机器人'}` : '本团尚未绑定真实群。';
  $('qq-group').value = room.qq?.groupId || ''; $('qq-mode').value = room.qq?.mode || 'mention';
  $('qq-delivery').replaceChildren();
  const deliveryLabels = { sending: '正在发送', 'bridge-ok': '桥接器已返回成功', 'accepted-async': '桥接器异步接收，未确认最终送达', failed: '发送失败', 'unknown-after-restart': '重启后送达状态未知' };
  for (const d of Object.values(room.deliveries || {})) record($('qq-delivery'), deliveryLabels[d.status] || d.status, d.error?.message || d.error || (d.at ? new Date(d.at).toLocaleString('zh-CN') : ''));
  if (!$('qq-delivery').children.length) $('qq-delivery').textContent = '尚无真实 QQ 发送记录。真实账号收发待联调。';
  if (switched) {
    const player = room.players?.find(p => p.id === currentPlayer);
    $('qq-user').value = pendingQq?.snapshot.userId || player?.id || '';
    $('qq-nickname').value = pendingQq?.snapshot.nickname || player?.name || '';
    $('qq-text').value = pendingQq?.snapshot.text || '';
  }
  renderRooms(); remember(); enabled();
}
function saveDraft() { if (!room) return false; drafts[room.id] = { text: $('message-text').value, kind: $('message-kind').value, playerId: $('current-player').value }; return remember(); }
function failedReceipt(next, messageId) {
  const receipt = next.receipts?.[messageId];
  return receipt?.status === 'failed' ? receipt.error?.message || receipt.error || '主持处理失败。已完成的骰点保留；草稿可重试。' : null;
}
async function loadAll() {
  const results = await Promise.all([api('/config'), api('/materials'), api('/rooms')]);
  config = results[0]; materials = results[1].materials || []; rooms = results[2].rooms || [];
  renderConfig(); renderMaterials(); renderRooms();
  const id = room?.id || saved.roomId;
  if (id && rooms.some(r => r.id === id)) renderRoom((await api(`/rooms/${encodeURIComponent(id)}`)).room);
  notice('已读取服务器配置与存档。真实 API 连接需单独测试。', true);
}
$('admin-token').value = token;
$('access-form').addEventListener('submit', event => { event.preventDefault(); token = $('admin-token').value.trim(); remember(); run(loadAll); });
$('forget-token').addEventListener('click', () => { token = ''; saved = {}; room = null; $('admin-token').value = ''; sessionStorage.removeItem(STORE); location.reload(); });
$('api-provider').addEventListener('change', fillProvider);
$('provider-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const body = { provider: $('api-provider').value, model: $('api-model').value.trim() };
  if ($('api-base').value.trim()) body.baseUrl = $('api-base').value.trim();
  if ($('delete-key').checked) body.deleteApiKey = true; else if ($('api-key').value.trim()) body.apiKey = $('api-key').value.trim();
  try { await api('/config', body); } finally { $('api-key').value = ''; }
  config = await api('/config'); renderConfig(); notice('配置已保存到服务器；尚未验证真实 API 连接。', true);
}); });
$('test-api').addEventListener('click', () => run(async () => { $('test-result').textContent = '正在发送一次真实 API 测试请求…'; try { const data = await api('/test', { provider: $('api-provider').value, confirmBillable: true }); $('test-result').textContent = `${data.ok ? '本次测试成功' : '本次测试失败'} · ${data.provider || ''} / ${data.model || ''}：${data.message || ''}`; if (!data.ok) notice(data.message || '连接测试失败。'); } catch (error) { $('test-result').textContent = `本次测试失败：${readable(error)}`; throw error; } }));
$('material-file').addEventListener('change', async () => { const file = $('material-file').files[0]; if (!file) return; if (!/\.(txt|md|markdown)$/i.test(file.name)) return notice('请选择 TXT 或 Markdown 文本文件。'); try { $('material-text').value = await file.text(); if (!$('material-title').value) $('material-title').value = file.name.replace(/\.[^.]+$/, ''); notice('文件已读取，请检查原文后保存到服务器。', true); } catch { notice('无法读取此文本文件。'); } });
$('material-form').addEventListener('submit', event => { event.preventDefault(); run(async () => { const data = await api('/materials', { kind: $('material-kind').value, title: $('material-title').value.trim(), text: $('material-text').value }); materials = (await api('/materials')).materials || []; renderMaterials(); if (data.material) $(`${data.material.kind}-id`).value = data.material.id; notice('原文已保存在服务器。可在开团时选择这份素材。', true); }); });
$('add-player').addEventListener('click', () => addPlayer());
$('room-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const players = [...$('players-edit').children].map(row => ({ id: row.querySelector('[data-field="id"]').value.trim(), name: row.querySelector('[data-field="name"]').value.trim() }));
  if (players.length < 2 || new Set(players.map(p => p.id)).size !== players.length || players.some(p => !p.id || !p.name)) throw new Error('请填写至少两位玩家，玩家 ID 不可重复。');
  const data = await api('/rooms', { name: $('room-name').value.trim(), provider: $('room-provider').value, rulesId: $('rules-id').value || undefined, scenarioId: $('scenario-id').value || undefined, players });
  rooms = (await api('/rooms')).rooms || []; renderRoom(data.room); notice('团已创建。请主持人开场，或直接发送消息。', true); $('table').scrollIntoView({ behavior: 'smooth' });
}); });
$('load-demo').addEventListener('click', () => { $('room-provider').value = 'demo'; $('rules-id').value = ''; $('scenario-id').value = ''; $('room-name').value = '余烬酒馆 · 离线协议演示'; $('players-edit').replaceChildren(); addPlayer('林舟', 'player-1'); addPlayer('沈鸦', 'player-2'); notice('已选择内置原创示例与两位玩家。点击「创建团」即可进入固定脚本演示；不代表真实模型智能。', true); $('create').scrollIntoView({ behavior: 'smooth' }); });
$('room-select').addEventListener('change', () => { const id = $('room-select').value; if (id) run(async () => renderRoom((await api(`/rooms/${encodeURIComponent(id)}`)).room)); });
$('refresh-room').addEventListener('click', () => run(async () => { rooms = (await api('/rooms')).rooms || []; renderRooms(); if (room) renderRoom((await api(`/rooms/${encodeURIComponent(room.id)}`)).room); notice('已刷新服务器团记录。', true); }));
$('current-player').addEventListener('change', () => { currentPlayer = $('current-player').value; pending = null; saveDraft(); const player = room?.players?.find(p => p.id === currentPlayer); if (player) { $('qq-user').value = player.id; $('qq-nickname').value = player.name; } });
$('message-text').addEventListener('input', saveDraft);
$('message-kind').addEventListener('change', saveDraft);
$('message-form').addEventListener('submit', event => { event.preventDefault(); if (!room || !$('message-text').value.trim()) return; run(async () => {
  const snapshot = { text: $('message-text').value.trim(), playerId: $('current-player').value, kind: $('message-kind').value };
  if (!pending || JSON.stringify(pending.snapshot) !== JSON.stringify(snapshot)) pending = { messageId: uuid(), snapshot };
  persistBeforeRequest();
  const data = await api(`/rooms/${encodeURIComponent(room.id)}/messages`, { messageId: pending.messageId, ...snapshot });
  const failure = failedReceipt(data.room, pending.messageId); renderRoom(data.room);
  if (failure) { notice(`${primitive(failure)}\n已保存失败与骰点。同一消息 ID 不会重跑；请编辑草稿后发送新一轮。`); return; }
  if (data.room.receipts?.[pending.messageId]?.status !== 'complete') { notice('服务器尚未确认本轮完成。草稿和消息 ID 已保留，重发会复用原 ID。'); return; }
  pending = null; $('message-text').value = ''; saveDraft();
}); });
$('message-text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy && room) $('message-form').requestSubmit(); } });
$('start-room').addEventListener('click', () => run(async () => {
  if (!room) return;
  pendingStart ||= { messageId: uuid(), snapshot: { roomId: room.id } };
  persistBeforeRequest();
  const data = await api(`/rooms/${encodeURIComponent(room.id)}/start`, { messageId: pendingStart.messageId });
  const failure = failedReceipt(data.room, pendingStart.messageId); renderRoom(data.room);
  if (failure) { notice(`${primitive(failure)}\n开场请求 ID 与骰点已保留，再次点击不会重跑。本轮失败后可编辑一条对话继续。`); return; }
  if (data.room.receipts?.[pendingStart.messageId]?.status !== 'complete') { notice('开场尚未确认完成，请求 ID 已保留。'); return; }
  pendingStart = null; remember();
}));
$('qq-config-form').addEventListener('submit', event => { event.preventDefault(); run(async () => { const qq = { apiBaseUrl: $('qq-url').value.trim(), enabled: $('qq-enabled').checked }; if ($('qq-token').value.trim()) qq.accessToken = $('qq-token').value.trim(); if ($('qq-secret').value.trim()) qq.secret = $('qq-secret').value.trim(); try { await api('/config', { qq }); } finally { $('qq-token').value = ''; $('qq-secret').value = ''; } config = await api('/config'); renderConfig(); notice('桥接配置已保存。真实 QQ 账号仍待联调。', true); }); });
$('qq-bind-form').addEventListener('submit', event => { event.preventDefault(); run(async () => { if (!room) throw new Error('请先选择一个团。'); const data = await api(`/rooms/${encodeURIComponent(room.id)}/qq`, { groupId: $('qq-group').value.trim(), mode: $('qq-mode').value }); renderRoom(data.room); notice('已保存群绑定。启用桥接后，符合触发条件的群事件将进入本团。', true); }); });
$('qq-sim-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  if (!room) throw new Error('请先选择一个团。');
  const snapshot = { roomId: room.id, userId: $('qq-user').value.trim(), nickname: $('qq-nickname').value.trim(), text: $('qq-text').value.trim() };
  if (!pendingQq || JSON.stringify(pendingQq.snapshot) !== JSON.stringify(snapshot)) pendingQq = { messageId: uuid(), snapshot };
  persistBeforeRequest();
  const data = await api('/qq/simulate', { ...snapshot, messageId: pendingQq.messageId });
  const key = `qq-sim:${pendingQq.messageId}`, failure = failedReceipt(data.room, key);
  renderRoom(data.room); $('qq-reply').textContent = `本地模拟公开回传：\n${primitive(data.reply || (failure ? '处理失败' : '已处理'))}`;
  if (failure) { notice(`${primitive(failure)}\n模拟草稿和消息 ID 已保留，请编辑内容后发送新一轮。`); return; }
  if (data.room.receipts?.[key]?.status !== 'complete') { notice('模拟请求尚未确认完成，草稿和消息 ID 已保留。'); return; }
  pendingQq = null; $('qq-text').value = ''; remember(); notice('本地 QQ 事件已处理；没有向真实 QQ 发消息。', true);
}); });
addPlayer('林舟', 'player-1'); addPlayer('沈鸦', 'player-2'); enabled();
if (token) run(loadAll);
