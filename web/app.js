'use strict';
const $ = id => document.getElementById(id);
const actionGuidance = document.querySelector('.rules-note');
actionGuidance.id = 'action-guidance';
actionGuidance.textContent = '自然语言交给 AI 主持：明确行动直接结算，歧义或多动作先澄清，提案由本人确认或取消。骰点、资源与剧情由服务器判定。本地导演为演示模式，真实模型需另行配置。';
$('action-text').setAttribute('aria-describedby','action-guidance');
const sceneNav = document.createElement('div'); sceneNav.className = 'scene-nav'; sceneNav.setAttribute('aria-label','可到达的地点');
$('location-description').after(sceneNav);
$('action-kind').append(new Option('前往地点','move'));
const sceneLabel = document.createElement('label'); sceneLabel.id = 'scene-label'; sceneLabel.textContent = '目的地';
const sceneSelect = document.createElement('select'); sceneSelect.id = 'scene-target'; sceneLabel.append(sceneSelect); $('action-options').append(sceneLabel);
const interactionLabel = document.createElement('label'); interactionLabel.textContent = '公开交互对象';
const interactionSelect = document.createElement('select'); interactionLabel.append(interactionSelect); $('action-options').append(interactionLabel);
for (const [kind,label] of [['interact','交互对象'],['rest','休整恢复'],['retreat','撤退收束']]) $('action-kind').append(option(kind,label));
$('action-kind').options[0].textContent = '自然语言 · AI 主持';
const proposalPanel = document.createElement('section'); proposalPanel.className = 'proposal-panel'; proposalPanel.hidden = true; proposalPanel.setAttribute('aria-live','polite');
const proposalTitle = textNode('h3','','待确认的行动提案'), proposalMessage = textNode('p','',''), proposalAction = textNode('p','hint',''), proposalHint = textNode('p','hint','');
const proposalConfirm = textNode('button','button primary','确认执行'), proposalCancel = textNode('button','button secondary','取消提案');
proposalConfirm.type = proposalCancel.type = 'button'; const proposalButtons = textNode('div','button-row',''); proposalButtons.append(proposalConfirm,proposalCancel);
proposalPanel.append(proposalTitle,proposalMessage,proposalAction,proposalHint,proposalButtons); $('action-text').before(proposalPanel);
const journeyPanel = textNode('section','panel progress-panel','');
const objectives = textNode('div','','开团后显示已公开目标。'), inventory = textNode('div','','背包暂时为空。'), interactions = textNode('div','','随探索显示公开交互对象。');
journeyPanel.append(textNode('span','eyebrow','YOUR JOURNEY'),textNode('h2','','当前目标'),objectives,textNode('h3','','队伍背包'),inventory,textNode('h3','','已知交互'),interactions);
const endingPanel = textNode('section','panel ending-panel',''); endingPanel.hidden = true; endingPanel.setAttribute('aria-live','polite');
const endingTitle = textNode('h2','',''), endingText = textNode('p','',''); endingPanel.append(textNode('span','eyebrow','ADVENTURE COMPLETE'),endingTitle,endingText,textNode('p','hint','冒险已收束。可查看记录、聊天，房主可导出完整存档。'));
document.querySelector('.right-column').prepend(endingPanel,journeyPanel);
$('qq-message').placeholder = '描述行动、回复澄清，或输入确认 / 取消';
$('qq-message').after(textNode('p','hint','模拟消息使用同一自然语言导演与剧情流程；只操作绑定的角色。真实 QQ 尚待联调。'));
const recoveryPanel = document.createElement('div'); recoveryPanel.className = 'recovery-panel'; recoveryPanel.hidden = true;
const recoveryLabel = document.createElement('label'); recoveryLabel.htmlFor = 'recovery-actor'; recoveryLabel.textContent = '认领恢复的原角色';
const recoverySelect = document.createElement('select'); recoverySelect.id = 'recovery-actor';
const recoveryButton = document.createElement('button'); recoveryButton.className = 'button secondary full'; recoveryButton.type = 'button'; recoveryButton.textContent = '切换到所选恢复角色';
const recoveryHint = document.createElement('p'); recoveryHint.className = 'hint'; recoveryHint.textContent = '恢复已轮换全部身份令牌。认领后可继续原角色；房主身份同时保留。其他参与者需要重新分发恢复身份。';
recoveryPanel.append(recoveryLabel,recoverySelect,recoveryButton,recoveryHint); $('restore-save').after(recoveryPanel);
const STORAGE = 'ai-kp.tab.v1';
let identity = {}, current = null, catalog = null, busy = false, pendingAction = null, refreshing = false;
try { identity = JSON.parse(sessionStorage.getItem(STORAGE) || '{}'); } catch { identity = {}; }
function remember() { sessionStorage.setItem(STORAGE, JSON.stringify(identity)); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function notice(message, success = false) { const el = $('notice'); el.textContent = message; el.className = success ? 'success' : ''; el.hidden = !message; }
function errorText(error) { return error.code ? `${error.message}（${error.code}）` : error.message; }
async function api(path, {method = 'GET', body, auth = 'none'} = {}) {
  const headers = {Accept: 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth === 'admin') { if (!identity.adminToken) throw new Error('请先在管理面板输入本机管理令牌。'); headers['X-Admin-Token'] = identity.adminToken; }
  if (auth === 'player' || auth === 'owner' || auth === 'session') {
    const token = auth === 'owner' ? identity.ownerToken : auth === 'player' ? identity.playerToken : identity.playerToken || identity.ownerToken;
    if (!token) throw new Error(auth === 'owner' ? '此操作需要房主身份。' : '请先创建或加入房间。');
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try { response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin'}); }
  catch { setConnection(false); throw new Error('无法连接本地服务器。请确认服务已启动；输入已保留，可重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('服务器返回了无法识别的响应。'); }
  if (!response.ok) { const err = new Error(data.error?.message || `请求失败：${response.status}`); err.code = data.error?.code; err.status = response.status; throw err; }
  setConnection(true); return data;
}
function setConnection(online) { $('connection').textContent = online ? '本地已连接' : '服务器离线'; $('connection').className = `badge ${online ? 'good' : 'bad'}`; }
async function run(task) {
  if (busy) return;
  busy = true; updateEnabled();
  try { await task(); } catch (error) { notice(errorText(error)); if (error.status === 409) { pendingAction = null; await refreshSession(true); } }
  finally { busy = false; updateEnabled(); }
}
function option(value, label) { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; }
function packageValue(row) { return JSON.stringify([row.id,row.version]); }
function selectedPackage(select) {
  try { const [id,version] = JSON.parse(select.value); return {id,version}; }
  catch { throw new Error('请选择有效的资料包版本。'); }
}
function fill(select, rows, placeholder) {
  const previous = select.value;
  const sorted = [...rows].sort((a,b) => {
    const av = a.version.split('.').map(Number), bv = b.version.split('.').map(Number);
    return bv[0]-av[0] || bv[1]-av[1] || bv[2]-av[2] || a.id.localeCompare(b.id);
  });
  select.replaceChildren();
  if (!sorted.length) select.append(option('', placeholder));
  for (const row of sorted) select.append(option(packageValue(row), `${row.name} · ${row.version}`));
  if (sorted.some(row => packageValue(row) === previous)) select.value = previous;
}
async function loadCatalog() {
  catalog = await api('/api/catalog');
  fill($('scenario'), catalog.scenarios || [], '暂无剧本，请导入');
  fill($('ruleset'), catalog.rules || [], '暂无规则，请导入');
  const previousProvider = $('create-provider').value;
  $('create-provider').replaceChildren(...(catalog.providers || []).map(provider => {
    const el = option(provider.id, `${provider.name}${provider.ready ? provider.id === 'mock' ? ' · 本地演示' : ' · 已就绪' : ' · 未配置'}`);
    el.disabled = !provider.ready; return el;
  }));
  $('create-provider').value = [...$('create-provider').options].some(o => o.value === previousProvider && !o.disabled) ? previousProvider : 'mock';
  describeScenario();
}
function describeScenario() {
  const selected = catalog?.scenarios?.find(item => packageValue(item) === $('scenario').value);
  $('scenario-summary').textContent = selected?.description || '冒险库为空。可在管理面板导入 JSON 资料包。';
}
function safeView(view) {
  // The owner response can contain GM secrets. Keep only public fields in the UI state.
  const keys = ['id','name','version','provider','paused','mode','location','sceneId','scenes','actors','enemies','turnActorId','role','actorId','rule','scenario','status','inventory','objectives','interactions','ending','pending','director'];
  return {...Object.fromEntries(keys.map(key => [key,view[key]])), events: (view.events || []).filter(e => e.audience === 'public' || (view.role === 'player' && e.audience === view.actorId)), personal: view.role === 'player' ? view.personal || [] : []};
}
function accept(view) { if (current?.id === view.id && current.version > view.version) return; current = safeView(view); render(); }
async function refreshSession(quiet = false) {
  if (!identity.sessionId || refreshing) return;
  refreshing = true;
  const sessionId = identity.sessionId;
  try { const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {auth: 'session'}); if (identity.sessionId === sessionId) accept(data.session); }
  catch (error) { if (!quiet) throw error; }
  finally { refreshing = false; }
}
function textNode(tag, className, content) { const el = document.createElement(tag); el.className = className; el.textContent = content; return el; }
function render() {
  const s = current; if (!s) { updateEnabled(); return; }
  $('room-name').textContent = s.name; $('provider').textContent = s.director === 'local-demo' || s.provider === 'mock' ? '本地演示导演' : `${s.provider} · 真实模型`;
  $('mode-label').textContent = isEnded() ? (s.status === 'won' ? '冒险完成' : '冒险已收束') : s.paused ? '冒险已暂停' : s.mode === 'combat' ? '战斗进行中' : '探索模式';
  $('version-label').textContent = `版本 ${s.version}`;
  $('room-share').hidden = false;
  $('room-share').textContent = `房间 ID：${s.id}${identity.inviteCode ? `　·　邀请码：${identity.inviteCode}` : ''}　·　${identity.playerToken ? '当前已加入玩家身份' : '房主已就绪，请在左侧填写名称并加入角色'}`;
  $('event-count').textContent = s.events.length;
  const eventsEl = $('events'); const nearBottom = eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight < 90;
  const previousIds = eventsEl.dataset.events; const ids = s.events.map(e => e.id).join('|');
  if (ids !== previousIds) {
    eventsEl.dataset.events = ids; eventsEl.replaceChildren();
    if (!s.events.length) eventsEl.append(textNode('p', 'muted', '冒险记录为空。提交第一条行动，让故事开始。'));
    for (const event of s.events) {
      const el = textNode('article', `event ${['say','kp','narration','opening'].includes(event.type) ? '' : 'system'} ${event.audience !== 'public' ? 'private' : ''}`, '');
      const meta = textNode('div', 'event-meta', '');
      const types = {kp:'主持人',narration:'主持人',opening:'主持人',say:'冒险者发言',check:'骰点结算',attack:'战斗结算',join:'队伍动态',control:'房间状态',end_turn:'回合更新',turn:'回合更新',combat:'战斗动态',move:'队伍移动'};
      Object.assign(types,{clarification:'导演澄清',proposal:'待确认提案',action:'执行行动',director:'导演决策',decision:'行动解析',interact:'交互结算',story:'剧情事件',trigger:'剧情事件',reveal:'线索揭示',inventory:'背包变化',objective:'目标进度',ending:'结局收束',rest:'休整结算',retreat:'撤退收束',confirm:'提案已确认',cancel:'提案已取消',dialogue:'对话'});
      meta.append(textNode('span', 'event-author', types[event.type] || event.type), textNode('span', '', `#${event.version}${event.audience !== 'public' ? ' · 仅你可见' : ''}`));
      el.append(meta, textNode('div', 'event-body', event.text)); eventsEl.append(el);
    }
    if (nearBottom || previousIds === undefined) eventsEl.scrollTop = eventsEl.scrollHeight;
  }
  $('party-count').textContent = `${s.actors.length} 位冒险者`;
  $('actors').replaceChildren();
  for (const actor of [...s.actors, ...s.enemies]) {
    const mine = actor.id === s.actorId, enemy = s.enemies.some(e => e.id === actor.id);
    const el = textNode('div', `actor${mine ? ' mine' : ''}`, '');
    const heading = textNode('div', 'actor-heading', ''); const name = textNode('div', 'actor-name', actor.name);
    name.append(textNode('span','actor-sub',`${mine ? '你的角色' : enemy ? '敌对生物' : '同行伙伴'}${s.turnActorId === actor.id ? ' · 当前回合' : ''} · AC ${actor.ac}`));
    heading.append(textNode('span','avatar', enemy ? '◇' : actor.name.slice(0,1)),name);
    const hp = textNode('div','actor-hp',''); hp.append(textNode('span','','生命值'),textNode('span','',`${actor.hp} / ${actor.maxHp}`));
    const track = textNode('div','hp-track',''); const bar = textNode('span','',''); bar.style.width = `${Math.max(0,Math.min(100,actor.hp / Math.max(1,actor.maxHp) * 100))}%`; track.append(bar);
    el.append(heading,hp,track,textNode('div','actor-resources',`耐力 ${actor.stamina}　·　检定加值 ${actor.bonus >= 0 ? '+' : ''}${actor.bonus}`)); $('actors').append(el);
  }
  if (!s.actors.length) $('actors').append(textNode('p','muted','尚无冒险者，请使用邀请码加入。'));
  const scene = s.scenes?.find(item => item.id === s.sceneId);
  $('location-name').textContent = scene?.name || s.location;
  $('location-description').textContent = scene ? scene.description + (scene.npcs.length ? '\n\n在场：' + scene.npcs.map(npc => `${npc.name} — ${npc.description}`).join('\n') : '') : '以主持叙述中的地点与距离为准；上图为装饰性位置示意。';
  const destinations = (s.scenes || []).filter(item => scene?.links.includes(item.id));
  const previousScene = sceneSelect.value; sceneSelect.replaceChildren(...destinations.map(item => option(item.id,item.name)));
  if (destinations.some(item => item.id === previousScene)) sceneSelect.value = previousScene;
  sceneNav.replaceChildren();
  if (destinations.length) sceneNav.append(textNode('p','hint','相邻地点 · 全队共同移动'));
  for (const destination of destinations) {
    const button = textNode('button','button secondary',`前往 ${destination.name} →`); button.type = 'button'; button.dataset.move = destination.id;
    button.addEventListener('click', () => run(() => submitAction('move',{sceneId:destination.id}))); sceneNav.append(button);
  }
  renderJourney(s);
  $('private-info').textContent = s.role === 'player' ? s.personal.join('\n\n') || '你暂时没有个人秘密。' : '房主默认使用公共视图。加入玩家角色后可查看个人札记。';
  recoveryPanel.hidden = !identity.ownerToken || !identity.recoveredPlayers?.length;
  const previousRecovery = recoverySelect.value;
  recoverySelect.replaceChildren(...(identity.recoveredPlayers || []).map(item => option(item.actorId,s.actors.find(a => a.id === item.actorId)?.name || item.actorId)));
  if ([...recoverySelect.options].some(o => o.value === previousRecovery)) recoverySelect.value = previousRecovery;
  const previousTarget = $('attack-target').value; $('attack-target').replaceChildren(...s.enemies.filter(e => e.hp > 0).map(e => option(e.id, `${e.name} · HP ${e.hp}`))); if ([...$('attack-target').options].some(o => o.value === previousTarget)) $('attack-target').value = previousTarget;
  updateEnabled();
}
function updateEnabled() {
  const canAct = !!(current && identity.playerToken && !current.paused && !busy);
  $('action-text').disabled = !canAct; $('send-button').disabled = !canAct;
  $('action-kind').disabled = !canAct;
  $('send-button').firstChild.textContent = busy ? '处理中… ' : '提交行动 ';
  $('actor-hint').textContent = !current ? '加入房间后可行动' : !identity.playerToken ? '请先加入一个玩家角色' : current.paused ? '房间已暂停' : current.mode === 'combat' ? `当前回合：${current.actors.find(a => a.id === current.turnActorId)?.name || '待定'}` : '自由探索 · 描述你的行动';
  $('owner-controls').hidden = !identity.ownerToken || !current;
  $('export-save').disabled = !identity.ownerToken || !current || busy;
  $('qq-bind').disabled = !identity.ownerToken || !identity.playerToken || busy;
  $('qq-simulate').disabled = !identity.sessionId || !identity.adminToken || busy;
  for (const button of document.querySelectorAll('button:not(#send-button):not(#export-save):not(#qq-bind):not(#qq-simulate)')) button.disabled = busy;
  for (const button of document.querySelectorAll('[data-move]')) button.disabled = !canAct || current.mode !== 'exploration';
  for (const button of document.querySelectorAll('[data-interact]')) button.disabled = !canAct || isEnded();
  if (isEnded()) for (const button of document.querySelectorAll('[data-move],[data-control]')) button.disabled = true;
  const p = current?.pending, canConfirm = canAct && !isEnded() && p && p.actorId === current.actorId && p.version === current.version;
  proposalConfirm.disabled = proposalCancel.disabled = !canConfirm;
  for (const opt of $('action-kind').options) opt.disabled = isEnded() && opt.value !== 'say';
  if (isEnded()) { $('actor-hint').textContent = '冒险已结束 · 可聊天与查看'; $('send-button').firstChild.textContent = busy ? '处理中… ' : '发送聊天 '; }
  updateActionOptions();
}
function updateActionOptions() {
  const kind = $('action-kind').value;
  $('action-text').disabled = kind !== 'say' || !current || !identity.playerToken || current.paused || busy;
  $('send-button').disabled = !current || !identity.playerToken || current.paused || busy || (isEnded() && kind !== 'say');
  $('action-options').hidden = !['check','attack','move','interact'].includes(kind);
  $('check-label').hidden = kind !== 'check'; $('target-label').hidden = kind !== 'attack';
  sceneLabel.hidden = kind !== 'move'; interactionLabel.hidden = kind !== 'interact';
  $('action-text').placeholder = kind === 'check' ? '检定由服务器掷 d20；难度、加值与耐力消耗由规则引擎判定。自由检定不会自动揭示剧本秘密。' : kind === 'attack' ? '选择攻击目标。命中、伤害与资源消耗由当前规则引擎判定。' : kind === 'end_turn' ? '提交后结束你的回合。敌人会自动反击。' : kind === 'move' ? '选择相邻地点。此行动会带领全队移动；战斗期间不可移动。' : '你想做什么？例如：我举起火把，仔细查看石门上的刻痕…';
  if (kind === 'interact') $('action-text').placeholder = '选择已公开交互对象，由服务器验证剧情条件和资源。';
  if (kind === 'rest') $('action-text').placeholder = '提交后休整恢复，具体条件与代价由服务器判定。';
  if (kind === 'retreat') $('action-text').placeholder = '提交后撤退并结束本次冒险，请确认你的选择。';
  if (kind === 'say' && isEnded()) $('action-text').placeholder = '冒险已经收束，可以聊聊本次旅程。';
}
$('admin-token').value = identity.adminToken || '';
$('admin-token').addEventListener('input', () => { identity.adminToken = $('admin-token').value.trim(); remember(); updateEnabled(); });
$('scenario').addEventListener('change', describeScenario);
for (const skill of ['察觉','调查','运动','隐匿','说服']) $('check-stat').append(option(skill, skill));
$('action-kind').addEventListener('change', updateActionOptions);
$('refresh').addEventListener('click', () => run(async () => { await api('/api/health'); if (identity.sessionId) await refreshSession(); else await loadCatalog(); }));
$('create-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const rule = selectedPackage($('ruleset')), scenario = selectedPackage($('scenario'));
  const data = await api('/api/sessions', {method:'POST',auth:'admin',body:{name:$('create-name').value.trim() || '余烬酒馆的冒险',ruleId:rule.id,ruleVersion:rule.version,scenarioId:scenario.id,scenarioVersion:scenario.version,provider:$('create-provider').value}});
  identity = {adminToken:identity.adminToken,sessionId:data.session.id,ownerToken:data.ownerToken,inviteCode:data.inviteCode}; remember(); pendingAction = null; accept(data.session);
  $('join-session').value = identity.sessionId; $('invite').value = identity.inviteCode;
  notice('房间已创建。填写左侧冒险者名称并加入，即可用自己的角色行动。',true); $('display-name').focus();
}); });
$('join-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const sessionId = $('join-session').value.trim();
  const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/join`, {method:'POST',body:{inviteCode:$('invite').value.trim(),name:$('display-name').value.trim()}});
  identity = {adminToken:identity.adminToken,...(identity.sessionId === sessionId ? {ownerToken:identity.ownerToken} : {}),sessionId,inviteCode:$('invite').value.trim(),playerToken:data.playerToken,actorId:data.actorId};
  remember(); pendingAction = null; accept(data.session); notice('你已加入冒险。现在可以描述行动。',true);
}); });
async function submitAction(kind, shortcutPayload) {
  if (!current || !identity.playerToken) throw new Error('请先加入玩家角色。');
  if (isEnded() && kind !== 'say') throw new Error('本次冒险已经结束，可聊天或查看记录。');
  if (kind === 'interact' && !(shortcutPayload?.targetId || interactionSelect.value)) throw new Error('当前没有可交互的公开对象。');
  const text = $('action-text').value.trim();
  if (kind === 'say' && !text) throw new Error('请先描述你的行动。');
  if (kind === 'attack' && !$('attack-target').value) throw new Error('当前没有可以攻击的目标。请由房主开始演示战斗。');
  if (kind === 'move' && !(shortcutPayload?.sceneId || sceneSelect.value)) throw new Error('当前没有可到达的相邻地点。');
  const payload = shortcutPayload || (kind === 'say' ? {text} : kind === 'check' ? {skill:$('check-stat').value} : kind === 'attack' ? {targetId:$('attack-target').value} : kind === 'move' ? {sceneId:sceneSelect.value} : kind === 'interact' ? {targetId:interactionSelect.value} : {});
  const signature = JSON.stringify({kind,payload});
  if (!pendingAction || pendingAction.signature !== signature) pendingAction = {signature,body:{requestId:uuid(),expectedVersion:current.version,kind,payload}};
  const data = await api(`/api/sessions/${encodeURIComponent(identity.sessionId)}/actions`, {method:'POST',auth:'player',body:pendingAction.body});
  pendingAction = null; accept(data.session); if (kind === 'say') $('action-text').value = ''; notice('');
}
for (const [button,kind] of [[proposalConfirm,'confirm'],[proposalCancel,'cancel']]) button.addEventListener('click',() => run(async () => {
  const p = current?.pending;
  if (!p || p.actorId !== current.actorId || p.version !== current.version) throw new Error('提案不属于你或已经失效，请刷新房间。');
  await submitAction(kind,{proposalId:p.id});
}));
$('action-form').addEventListener('submit', event => { event.preventDefault(); const kind = $('action-kind').value; run(() => submitAction(kind)); });
$('action-text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('action-form').requestSubmit(); } });
for (const button of document.querySelectorAll('[data-control]')) button.addEventListener('click', () => run(async () => {
  await api(`/api/sessions/${encodeURIComponent(identity.sessionId)}/control`,{method:'POST',auth:'owner',body:{requestId:uuid(),expectedVersion:current.version,command:button.dataset.control}});
  await refreshSession(); notice('房间状态已更新。',true);
}));
$('config-button').addEventListener('click', () => run(async () => {
  const data = await api('/api/config',{auth:'admin'});
  $('config-status').textContent = data.providers.map(p => `${p.name || p.id}：${p.ready ? '已就绪' : '未就绪'} · ${p.status}${p.model ? ` · ${p.model}` : ''}`).join('\n') + '\nQQ：' + data.qq.status + '\n此处为只读状态。服务器环境变量：OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY。配置后重启服务器，再刷新目录选择已就绪模型。'; notice('已读取脱敏接入状态。',true);
}));
for (const operation of ['validate','import']) $(`${operation}-package`).addEventListener('click', () => run(async () => {
  let body; try { body = JSON.parse($('package-json').value); } catch { throw new Error('JSON 格式无效，请检查引号、逗号与括号。'); }
  const data = await api(`/api/packages/${operation}`,{method:'POST',auth:'admin',body});
  $('package-result').textContent = `${operation === 'validate' ? '校验通过' : '导入成功'}：${data.package.name} (${data.package.id}@${data.package.version})`;
  if (operation === 'import') await loadCatalog(); notice(operation === 'validate' ? '资料包校验通过。' : '资料包已导入冒险库。',true);
}));
$('export-save').addEventListener('click', () => run(async () => {
  const data = await api(`/api/sessions/${encodeURIComponent(identity.sessionId)}/export`,{auth:'owner'});
  const url = URL.createObjectURL(new Blob([JSON.stringify(data.save,null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `ai-kp-${identity.sessionId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); notice('完整存档已导出，含主持秘密，请妥善保管。',true);
}));
$('restore-save').addEventListener('click', () => run(async () => {
  const file = $('restore-file').files[0]; if (!file) throw new Error('请先选择 JSON 存档文件。'); if (file.size > 1024 * 1024) throw new Error('存档超过 1 MiB，请选择有效存档。');
  let save; try { save = JSON.parse(await file.text()); } catch { throw new Error('存档不是有效的 JSON。'); }
  const data = await api('/api/sessions/restore',{method:'POST',auth:'admin',body:{save}});
  identity = {adminToken:identity.adminToken,sessionId:data.session.id,ownerToken:data.ownerToken,inviteCode:data.inviteCode,recoveredPlayers:data.recoveredPlayers || []}; remember(); pendingAction = null; accept(data.session);
  $('join-session').value = identity.sessionId; $('invite').value = identity.inviteCode; notice('已恢复为新房间并轮换凭证。请在管理面板认领原角色，再继续冒险。',true);
}));
recoveryButton.addEventListener('click', () => run(async () => {
  const recovered = identity.recoveredPlayers?.find(item => item.actorId === recoverySelect.value);
  if (!recovered) throw new Error('没有可认领的恢复角色。');
  identity.playerToken = recovered.playerToken; identity.actorId = recovered.actorId; remember(); pendingAction = null;
  await refreshSession(); notice('已切换到恢复的原角色。房主控制权限已保留。',true);
}));
$('leave-session').addEventListener('click', () => { identity = {adminToken:identity.adminToken}; remember(); location.reload(); });
$('qq-bind').addEventListener('click', () => run(async () => {
  const qqUserId = $('qq-user').value.trim(); if (!qqUserId) throw new Error('请输入模拟 QQ 用户 ID。');
  await api('/api/qq/bind',{method:'POST',auth:'owner',body:{sessionId:identity.sessionId,qqUserId,playerToken:identity.playerToken}}); notice('本地 QQ 身份映射已绑定；未连接真实 QQ。',true);
}));
let pendingQQ = null;
$('qq-simulate').addEventListener('click', () => run(async () => {
  const qqUserId = $('qq-user').value.trim(), text = $('qq-message').value.trim(); if (!qqUserId || !text) throw new Error('请先填写并绑定 QQ 用户 ID，再输入模拟消息。');
  const signature = JSON.stringify({qqUserId,text}); if (!pendingQQ || pendingQQ.signature !== signature) pendingQQ = {signature,body:{sessionId:identity.sessionId,qqUserId,eventId:uuid(),text,expectedVersion:current.version}};
  try { await api('/api/qq/simulate',{method:'POST',auth:'admin',body:pendingQQ.body}); } catch(error) { if(error.status === 409) pendingQQ = null; throw error; }
  pendingQQ = null; $('qq-message').value = ''; await refreshSession(); notice('本地 QQ 模拟事件已处理；未向真实 QQ 发送消息。',true);
}));
async function init() {
  if (identity.sessionId) { $('join-session').value = identity.sessionId; $('invite').value = identity.inviteCode || ''; }
  updateEnabled();
  try { await api('/api/health'); await loadCatalog(); await refreshSession(); }
  catch (error) { notice(errorText(error)); $('scenario').replaceChildren(option('','服务器离线')); $('ruleset').replaceChildren(option('','服务器离线')); }
}
init();
setInterval(() => { if (!busy && !document.hidden) refreshSession(true); },6000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refreshSession(true); });

function isEnded() { return !!current?.status && current.status !== 'active'; }
function renderJourney(s) {
  const rows = (el,items,empty,renderItem) => { el.replaceChildren(); if (!items?.length) el.append(textNode('p','muted',empty)); else items.forEach(item => el.append(renderItem(item))); };
  rows(objectives,s.objectives,'暂无已公开目标。',item => textNode('p',`objective${item.completed ? ' completed' : ''}`,`${item.completed ? '✓' : '○'} ${item.text}`));
  rows(inventory,s.inventory,'背包暂时为空。',item => textNode('p','inventory-item',`${item.name} × ${item.quantity}`));
  rows(interactions,s.interactions,'此处暂无已公开交互。',item => {
    const el = textNode('div','interaction-card',''); el.append(textNode('strong','',item.label),textNode('p','muted',item.description));
    const button = textNode('button','button secondary','执行交互 →'); button.type = 'button'; button.dataset.interact = item.id;
    button.addEventListener('click',() => run(() => submitAction('interact',{targetId:item.id}))); el.append(button); return el;
  });
  const oldTarget = interactionSelect.value; interactionSelect.replaceChildren(...(s.interactions || []).map(item => option(item.id,item.label)));
  if ((s.interactions || []).some(item => item.id === oldTarget)) interactionSelect.value = oldTarget;
  endingPanel.hidden = !isEnded(); endingTitle.textContent = s.ending?.title || '本次冒险已经结束'; endingText.textContent = s.ending?.text || '查看冒险记录，回顾你们的选择。';
  const p = s.pending; proposalPanel.hidden = !p || isEnded(); proposalMessage.textContent = p?.message || '';
  const labels = {move:'移动',attack:'攻击',interact:'交互',check:'检定',rest:'休整',retreat:'撤退',end_turn:'结束回合'};
  const action = p?.action; const targetId = action?.payload?.targetId || action?.payload?.sceneId;
  const target = [...(s.interactions || []).map(i => ({id:i.id,name:i.label})),...(s.scenes || []),...(s.enemies || [])].find(i => i.id === targetId);
  proposalAction.textContent = action ? `拟执行：${labels[action.kind] || '规则行动'}${target ? ` · ${target.name}` : ''}。确认后由服务器验证并结算。` : '';
  proposalHint.textContent = !p ? '' : p.actorId !== s.actorId ? '提案属于其他冒险者，只有本人可确认或取消。' : p.version !== s.version ? '提案已过期，请重新描述行动。' : '提案尚未执行。由你确认、取消或继续描述自己的选择。';
}
