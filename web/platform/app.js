// Organizer console. Shows setup, health and cost, and the public log only — never secrets.
// The KP view is fetched separately and only after the organizer unlocks it for review.
// All rendering uses textContent; nothing from the server is parsed as HTML.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const option = (value, label) => { const o = el("option", "", label); o.value = value; return o; };

const saved = (() => {
  try { return JSON.parse(sessionStorage.getItem("aikp-organizer") || "{}"); } catch { return {}; }
})();
let token = saved.token || "";
let campaignId = saved.campaignId || "";
let view = null;
let busy = false;
let poll = null;
let scenarios = [];
let providers = [];
let roles = { compile: { provider: null, model: null }, main: { provider: null, model: null }, aux: { provider: null, model: null } };

// ---------------- providers & model lists ----------------
const PROVIDER_LABEL = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", gemini: "Google Gemini", demo: "离线演示" };
const providerName = (p) => `${PROVIDER_LABEL[p.id] || p.id}${p.configured ? "" : "（未配置）"}`;
/** Replace a select's options, keeping the current choice when it still exists. */
function fillSelect(id, options, fallback) {
  const s = $(id);
  const keep = s.value;
  s.replaceChildren(...options);
  if (keep && [...s.options].some((o) => o.value === keep)) s.value = keep;
  else if (fallback !== undefined) s.value = fallback;
}
const modelCache = new Map(); // provider -> models[] (or a pending promise)
async function modelsOf(provider, force = false) {
  if (!provider || provider === "demo") return [];
  if (!force && modelCache.has(provider)) return modelCache.get(provider);
  const p = api("GET", `/providers/${provider}/models`).then((r) => r.models);
  modelCache.set(provider, p);
  try {
    const models = await p;
    modelCache.set(provider, models);
    fillDatalist(provider, models);
    return models;
  } catch (e) {
    modelCache.delete(provider);
    throw e;
  }
}
const priceText = (m) => (m.price ? ` · $${m.price.input}/$${m.price.output} 每百万 token` : "");
function fillDatalist(provider, models) {
  let dl = $(`ml-${provider}`);
  if (!dl) {
    dl = el("datalist");
    dl.id = `ml-${provider}`;
    $("model-lists").append(dl);
  }
  dl.replaceChildren(...models.map((m) => option(m.id, `${m.name && m.name !== m.id ? m.name : ""}${priceText(m)}`.replace(/^ · /, ""))));
}
/** Link a model input to the model list of whichever provider its select points at; fetch on first focus. */
function bindModelInput(inputId, providerOf) {
  const input = $(inputId);
  const sync = () => input.setAttribute("list", `ml-${providerOf()}`);
  input.addEventListener("focus", () => {
    sync();
    const p = providerOf();
    if (providers.find((x) => x.id === p)?.configured || p === "openrouter") modelsOf(p).catch(() => {});
  });
  return sync;
}

function remember() {
  try { sessionStorage.setItem("aikp-organizer", JSON.stringify({ token, campaignId })); } catch {}
}
function notice(text, ok = false) {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
  $("notice").className = ok ? "notice ok" : "notice";
}

async function api(method, path, body) {
  if (!token) throw new Error("请先填写管理令牌");
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: { "X-Admin-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    $("status").textContent = "服务不可达";
    $("status").className = "badge bad";
    throw new Error("连不上本地服务，请确认它在运行");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { $("status").textContent = "令牌无效"; $("status").className = "badge bad"; }
    throw new Error(data.error?.message || `请求失败（HTTP ${res.status}）`);
  }
  $("status").textContent = "已连接";
  $("status").className = "badge good";
  return data;
}
async function run(fn) {
  try { notice(""); await fn(); } catch (e) { notice(e.message || String(e)); }
}
function setBusy(b) {
  busy = b;
  for (const id of ["start", "compress", "reissue"]) $(id).disabled = b || !campaignId;
}

// ---------------- loading ----------------
async function loadAll() {
  const [sys, prov, sc, cp, rl] = await Promise.all([
    api("GET", "/systems"), api("GET", "/providers"), api("GET", "/scenarios"), api("GET", "/campaigns"), api("GET", "/roles"),
  ]);
  $("cp-system").replaceChildren(...sys.systems.map((s) => option(s.id, s.name)));
  providers = prov.providers;
  roles = rl.roles;
  const firstConfigured = providers.find((p) => p.configured && p.id !== "demo")?.id || "demo";
  const all = () => providers.map((p) => option(p.id, providerName(p)));
  for (const role of ["compile", "main", "aux"]) fillSelect(`role-${role}-provider`, [option("", "未设置"), ...all()]);
  if (!$("roles-form").dataset.touched) renderRoles();
  fillSelect("cp-provider", all(), roles.main.provider || firstConfigured);
  fillSelect("md-provider", all());
  fillSelect("pv-id", providers.filter((p) => p.id !== "demo").map((p) => option(p.id, providerName(p))), "openrouter");
  $("providers").replaceChildren(...providers.map((p) => el("li", "", `${PROVIDER_LABEL[p.id] || p.id}：${p.model}${p.apiMode ? ` · ${p.apiMode === "chat" ? "Chat 兼容" : "Responses"}` : ""}${p.reasoningEffort ? ` · 推理 ${p.reasoningEffort}` : ""} · ${p.configured ? "已配置" : "未配置"}`)));
  const auxOptions = () => [option("", "按默认分工"), ...all()];
  fillSelect("cp-aux-provider", auxOptions());
  fillSelect("md-aux-provider", auxOptions());
  // Background refreshes must not wipe what the organizer is typing.
  if (!$("provider-form").dataset.touched) renderProviderForm();
  scenarios = sc.scenarios;
  const keep = $("cp-scenario").value;
  $("cp-scenario").replaceChildren(...scenarios.map((s) => option(s.id, `${s.title}${s.compileStatus === "done" ? "" : `（${STATUS[s.compileStatus]}）`}`)));
  if (keep && scenarios.some((s) => s.id === keep)) $("cp-scenario").value = keep;
  fillSelect("sc-provider", all(), roles.compile.provider || firstConfigured);
  roleHints();
  renderScenarios();
  renderBlurb();
  renderCampaigns(cp.campaigns);
  if (campaignId) await loadCampaign();
}

const STATUS = { none: "未整理", running: "整理中…", done: "已整理", failed: "整理失败" };

function blurbLines(b) {
  if (!b) return [];
  return [
    b.pitch,
    b.setting,
    [b.players && `人数 ${b.players}`, b.duration && `时长 ${b.duration}`, b.tone && `基调 ${b.tone}`, b.recommendedSystem && `规则 ${b.recommendedSystem}`].filter(Boolean).join(" · "),
    b.contentWarnings?.length ? `内容提醒：${b.contentWarnings.join("、")}` : "",
  ].filter(Boolean);
}

function renderScenarios() {
  $("scenarios").replaceChildren(...(scenarios.length ? scenarios.map((s) => {
    const li = el("li", "scenario");
    li.append(el("strong", "", s.title), el("span", `badge ${s.compileStatus === "done" ? "good" : s.compileStatus === "failed" ? "bad" : ""}`, STATUS[s.compileStatus]));
    li.append(el("div", "muted small", `${s.characters} 字 · ${s.chunks} 段`));
    for (const line of blurbLines(s.blurb)) li.append(el("div", "small", line));
    if (s.compileStatus === "failed" && s.compileError) li.append(el("div", "bad small", s.compileError));
    if (s.compileStatus !== "running") {
      const b = el("button", "", s.compileStatus === "done" ? "重新整理" : "整理剧本");
      b.type = "button";
      b.onclick = () => run(async () => {
        const body = { provider: $("sc-provider").value };
        if ($("sc-model").value.trim()) body.model = $("sc-model").value.trim();
        await api("POST", `/scenarios/${s.id}/compile`, body);
        notice(`已开始整理《${s.title}》，完成后会显示简介`, true);
        await loadAll();
      });
      li.append(b);
    }
    return li;
  }) : [el("li", "muted", "还没有剧本")]));
}

function renderBlurb() {
  const s = scenarios.find((x) => x.id === $("cp-scenario").value);
  $("cp-blurb").replaceChildren(...(!s ? [] : s.compileStatus !== "done"
    ? [el("div", "", `这个剧本${STATUS[s.compileStatus]}；没整理的剧本 KP 只能边查原文边主持。`)]
    : blurbLines(s.blurb).map((t) => el("div", "", t))));
}

function renderCampaigns(list) {
  $("campaigns").replaceChildren(
    ...(list.length ? list.map((c) => {
      const li = el("li");
      const b = el("button", c.id === campaignId ? "active" : "", `${c.name} · ${c.systemId} · ${c.provider} · ${c.turns} 轮`);
      b.type = "button";
      b.onclick = () => run(async () => {
        campaignId = c.id; remember();
        $("invites").replaceChildren();
        $("kp-view").hidden = true;
        await loadCampaign(); renderCampaigns(list);
      });
      li.append(b);
      return li;
    }) : [el("li", "muted", "还没有团")]),
  );
}

async function loadCampaign() {
  if (!campaignId) return;
  try {
    view = await api("GET", `/campaigns/${campaignId}`);
  } catch (e) {
    campaignId = ""; remember(); view = null; throw e;
  }
  render();
  setBusy(busy);
}

// ---------------- rendering ----------------
function render() {
  const { campaign, scenario, players, public: pub } = view;
  $("room-name").textContent = campaign.name;
  $("room-meta").textContent = `${scenario.title} · ${campaign.systemId} · ${campaign.provider} · ${players.length} 位玩家`;
  renderLog(pub.events);
  renderPlayers();
  renderModels();
  renderCompression();
  $("review-enabled").checked = view.review?.enabled !== false;
  renderDiagnostics();
  renderReveal();
}

const nameOf = (id) => view?.players.find((p) => p.id === id)?.name || id;

function renderLog(events) {
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...events.map((e) => {
    const li = el("li", e.type);
    const label = { player: `${e.actor ? nameOf(e.actor) : "主持请求"}${e.data?.kind ? ` · ${e.data.kind}` : ""}`, kp: "KP", roll: "骰点", error: "错误", system: "系统" }[e.type] ?? "";
    if (label) li.append(el("div", "who", label));
    li.append(el("div", "", e.text));
    return li;
  }));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderPlayers() {
  $("players").replaceChildren(...view.players.map((p) =>
    el("li", "", `${p.name}（${p.id}）· ${p.invited ? "已有邀请链接" : "未生成链接"} · ${p.hasSheet ? "有角色卡" : "无角色卡"}`)));
}

function showInvites(invites) {
  const box = $("invites");
  box.replaceChildren(el("p", "muted small", "邀请链接只显示这一次，请发给对应玩家。重新生成后旧链接失效。"));
  for (const inv of invites) {
    const url = `${location.origin}/play#t=${inv.token}`;
    const row = el("div", "invite");
    row.append(el("strong", "", inv.name));
    const input = el("input");
    input.readOnly = true;
    input.value = url;
    input.onfocus = () => input.select();
    const copy = el("button", "", "复制");
    copy.type = "button";
    copy.onclick = () => run(async () => { await navigator.clipboard.writeText(url); notice(`已复制 ${inv.name} 的链接`, true); });
    const open = el("a", "", "打开");
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    row.append(input, copy, open);
    box.append(row);
  }
}

function renderModels() {
  const m = view.models;
  $("models-info").replaceChildren(
    ...(m ? [el("div", "", `主力：${m.main.provider} · ${m.main.model}`), el("div", "", `辅助：${m.aux.provider} · ${m.aux.model}`)]
      : [el("div", "", "模型配置无效，请检查供应商设置")]),
  );
  const s = view.campaign.models;
  if (document.activeElement?.closest?.("#models-form") == null) {
    $("md-provider").value = view.campaign.provider;
    $("md-main").value = s.main || "";
    $("md-aux-provider").value = s.auxProvider || "";
    $("md-aux").value = s.auxModel || "";
  }
  const u = view.usage;
  const k = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : String(n));
  $("usage").textContent = u.turns
    ? `${u.turns} 轮 · 输入 ${k(u.input)}（缓存 ${u.input ? Math.round((u.cached / u.input) * 100) : 0}%）· 输出 ${k(u.output)}${u.cost !== null ? ` · $${u.cost.toFixed(3)}` : ""} · 摘要 ${view.memory.summaries} 段`
    : "尚无用量";
}

function renderCompression() {
  const c = view.compression;
  const pct = Math.min(100, Math.round((c.pendingTokens / c.threshold) * 100));
  $("compression").replaceChildren(
    el("div", "", `未压缩记录 ${c.pendingTokens} / ${c.threshold} token（${pct}%）${c.custom ? "" : " · 默认阈值"}${c.running ? " · 正在压缩…" : ""}`),
    el("div", "", `已有片段摘要 ${c.summaries} 段、章节摘要 ${c.chapters} 段${c.summarizedThroughTurn ? ` · 已压缩到第 ${c.summarizedThroughTurn} 轮` : " · 尚未压缩"}`),
    ...(c.repairs && (c.repairs.retried || c.repairs.patched) ? [el("div", "", `摘要保真：重写 ${c.repairs.retried} 次，补写 ${c.repairs.patched} 处遗漏`)] : []),
    ...(c.lastError ? [el("div", "cmp-error", `上次压缩失败：${c.lastError}`)] : []),
  );
  if (document.activeElement?.id !== "cmp-threshold") $("cmp-threshold").value = c.custom ? c.threshold : "";
}

const DIRECTIVE = { hint: "给线索", escalate: "加压", breathe: "喘息", spotlight: "聚光", wrap_up: "收束" };

function renderDiagnostics() {
  const failed = new Map(view.turns.filter((t) => t.status === "failed").map((t) => [t.n, t.error]));
  const items = view.diagnostics.slice(-15).reverse().map((d) => {
    const li = el("li");
    const tools = d.tools.map((t) => `${t.name}${t.ok ? "" : `✗${t.error ? `(${t.error})` : ""}`}`).join(" ");
    const kinds = d.directives.length ? d.directives.map((k) => DIRECTIVE[k] || k).join("、") : "无";
    const cost = d.usage?.cost != null ? ` · $${d.usage.cost.toFixed(4)}` : "";
    li.append(
      el("div", "", `第 ${d.n ?? "?"} 轮 · ${d.rounds ?? "?"} 步 · ${d.via === "text" ? "纯文本回复" : "reply 工具"} · 上下文 ${d.contextTokens ?? "?"}${cost}`),
      el("div", "muted small", `工具：${tools || "无"}`),
      el("div", "muted small", `节奏建议：${kinds}`),
      ...(d.review ? [el("div", d.review.rejected ? "small" : "muted small", `防剧透审核：${d.review.rejected ? `退回重写 ${d.review.rejected} 次` : "通过"}${d.review.errors ? `（${d.review.errors} 次没能审核，已直接发出）` : ""}`)] : []),
    );
    return li;
  });
  const failures = [...failed].reverse().slice(0, 5).map(([n, err]) => el("li", "bad", `第 ${n} 轮失败：${err}`));
  $("diagnostics").replaceChildren(...failures, ...(items.length ? items : [el("li", "muted", "尚无回合")]));
}

function renderReveal() {
  const box = $("reveal-box");
  if (!view.campaign.revealedAt) {
    const b = el("button", "danger", "解锁 KP 视图（会被剧透）");
    b.type = "button";
    b.onclick = () => run(async () => {
      if (!confirm("解锁后你会看到本团全部秘密：剧本真相、KP 笔记、暗骰、威胁时钟。\n这个操作无法撤销，并会公开告知所有玩家。\n\n只建议在游戏结束后复盘时使用。确定解锁吗？")) return;
      await api("POST", `/campaigns/${campaignId}/reveal`, { confirm: true });
      await loadCampaign();
      await showKp();
    });
    box.replaceChildren(el("p", "muted small", "KP 视图已锁定。游戏结束后可以解锁复盘。"), b);
  } else {
    const b = el("button", "", "查看 KP 视图");
    b.type = "button";
    b.onclick = () => run(showKp);
    box.replaceChildren(el("p", "muted small", `已于 ${new Date(view.campaign.revealedAt).toLocaleString()} 解锁。`), b);
  }
}

function list(title, items) {
  const box = el("div");
  box.append(el("strong", "", title));
  if (!items.length) { box.append(el("div", "muted", "—")); return box; }
  const ul = el("ul");
  ul.append(...items.map((t) => el("li", "", t)));
  box.append(ul);
  return box;
}

async function showKp() {
  const kp = await api("GET", `/campaigns/${campaignId}/kp`);
  const s = kp.state;
  const box = $("kp-view");
  box.hidden = false;
  box.replaceChildren(
    list("KP 笔记", s.kpNotes),
    list("威胁时钟", Object.entries(s.clocks).map(([n, c]) => `${n} ${c.filled}/${c.size}${c.note ? ` · ${c.note}` : ""}`)),
    list("线索", s.clues.map((c) => c.text)),
    list("KP 版摘要", kp.summaries.map((x) => x.kpText)),
    list("暗骰与 KP 记录", kp.events.filter((e) => e.visibility !== "public" && e.type !== "directive").map((e) => `[${e.type}] ${e.text}`)),
  );
}

// ---------------- actions ----------------
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

$("token-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  remember();
  run(loadAll);
});

$("scenario-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    const f = $("sc-file").files[0];
    if (!f) throw new Error("请选择剧本文件");
    const text = await f.text();
    const compile = { provider: $("sc-provider").value };
    if ($("sc-model").value.trim()) compile.model = $("sc-model").value.trim();
    const r = await api("POST", "/scenarios", { title: $("sc-title").value || f.name.replace(/\.(txt|md)$/i, ""), text, compile });
    notice(`已导入《${r.scenario.title}》：${r.scenario.characters} 字。正在整理，完成后显示简介`, true);
    $("scenario-form").reset();
    await loadAll();
  });
});
$("cp-scenario").addEventListener("change", renderBlurb);
$("sc-file").addEventListener("change", () => {
  const f = $("sc-file").files[0];
  if (f && !$("sc-title").value) $("sc-title").value = f.name.replace(/\.(txt|md)$/i, "");
});

$("campaign-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    const players = $("cp-players").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, ...rest] = l.split(/[,，]/);
      return { id: id.trim(), name: rest.join(",").trim() || id.trim() };
    });
    const r = await api("POST", "/campaigns", {
      name: $("cp-name").value, scenarioId: $("cp-scenario").value, systemId: $("cp-system").value,
      provider: $("cp-provider").value, players,
      models: { main: $("cp-main").value.trim() || null, auxProvider: $("cp-aux-provider").value || null, auxModel: $("cp-aux").value.trim() || null },
    });
    campaignId = r.campaign.id;
    remember();
    await loadAll();
    showInvites(r.invites);
    notice("团已建立。把邀请链接发给玩家，然后点「开场」", true);
  });
});

// The settings form shows the stored values of the selected provider.
function renderProviderForm() {
  const p = providers.find((x) => x.id === $("pv-id").value);
  if (!p) return;
  $("pv-status").textContent = `${p.configured ? "已配置 API key" : "未配置 API key"} · 当前默认模型 ${p.model}`;
  $("pv-mode-row").hidden = p.id !== "openai";
  $("pv-mode").value = p.apiMode || "responses";
  $("pv-url").value = p.baseUrl || "";
  $("pv-model").value = p.model || "";
  $("pv-effort").value = p.reasoningEffort || "";
  $("pv-max").value = p.maxTokens || "";
  $("pv-key").value = "";
  $("pv-key-delete").checked = false;
  $("pv-model-info").textContent = "";
  $("pv-model").setAttribute("list", `ml-${p.id}`);
  delete $("provider-form").dataset.touched;
}
$("pv-id").addEventListener("change", renderProviderForm);
$("provider-form").addEventListener("input", (e) => {
  if (e.target.id !== "pv-id") $("provider-form").dataset.touched = "1";
});
$("pv-fetch").addEventListener("click", () => run(async () => {
  const id = $("pv-id").value;
  $("pv-fetch").disabled = true;
  $("pv-model-info").textContent = "正在获取…";
  try {
    const models = await modelsOf(id, true);
    $("pv-model-info").textContent = `共 ${models.length} 个可用模型，在"默认模型"里输入关键词即可筛选`;
    $("pv-model").focus();
  } catch (e) {
    $("pv-model-info").textContent = "";
    throw e;
  } finally {
    $("pv-fetch").disabled = false;
  }
}));
$("pv-model").addEventListener("change", () => {
  const list = modelCache.get($("pv-id").value);
  const m = Array.isArray(list) ? list.find((x) => x.id === $("pv-model").value.trim()) : null;
  $("pv-model-info").textContent = m ? `${m.name || m.id}${m.contextLength ? ` · 上下文 ${Math.round(m.contextLength / 1000)}k` : ""}${priceText(m)}` : "";
});
$("provider-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("pv-id").value;
  const p = providers.find((x) => x.id === id);
  run(async () => {
    // Send only what changed; an emptied field means "back to the default".
    const body = {};
    if ($("pv-key").value.trim()) body.apiKey = $("pv-key").value.trim();
    if ($("pv-key-delete").checked) body.deleteApiKey = true;
    const model = $("pv-model").value.trim();
    if (model !== (p?.model || "")) body.model = model || null;
    const url = $("pv-url").value.trim();
    if (url !== (p?.baseUrl || "")) body.baseUrl = url || null;
    if ($("pv-effort").value !== (p?.reasoningEffort || "")) body.reasoningEffort = $("pv-effort").value || null;
    const max = $("pv-max").value.trim();
    if (max !== String(p?.maxTokens || "")) body.maxTokens = max ? Number(max) : null;
    if (id === "openai" && $("pv-mode").value !== (p?.apiMode || "responses")) body.apiMode = $("pv-mode").value;
    await api("POST", `/providers/${id}`, body);
    modelCache.delete(id);
    delete $("provider-form").dataset.touched;
    notice(`${PROVIDER_LABEL[id] || id} 设置已保存`, true);
    await loadAll();
  });
});

$("compression-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!campaignId) return;
  const raw = $("cmp-threshold").value.trim();
  run(async () => {
    await api("PUT", `/campaigns/${campaignId}/compression`, { threshold: raw ? Number(raw) : null });
    notice(raw ? `压缩阈值已设为 ${raw} token` : "已恢复默认压缩阈值", true);
    await loadCampaign();
  });
});

$("models-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!campaignId) return;
  run(async () => {
    await api("PUT", `/campaigns/${campaignId}/models`, {
      provider: $("md-provider").value,
      main: $("md-main").value.trim() || null,
      auxProvider: $("md-aux-provider").value || null,
      auxModel: $("md-aux").value.trim() || null,
    });
    notice("本团模型已更新，下一轮生效", true);
    await loadCampaign();
  });
});

$("reissue").addEventListener("click", () => run(async () => {
  if (!confirm("重新生成后，所有旧的邀请链接都会失效。继续吗？")) return;
  const r = await api("POST", `/campaigns/${campaignId}/invites`, {});
  showInvites(r.invites);
  await loadCampaign();
}));

$("add-player").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!campaignId) return;
  run(async () => {
    const r = await api("POST", `/campaigns/${campaignId}/players`, { id: $("np-id").value.trim(), name: $("np-name").value.trim() });
    $("add-player").reset();
    showInvites([r.invite]);
    await loadCampaign();
  });
});

$("start").addEventListener("click", () => run(async () => {
  setBusy(true);
  try {
    const r = await api("POST", `/campaigns/${campaignId}/start`, { messageId: newId() });
    if (r.turn.status === "failed") notice(r.turn.error || "开场失败");
    await loadAll();
  } finally { setBusy(false); }
}));
$("compress").addEventListener("click", () => run(async () => {
  setBusy(true);
  try {
    const r = await api("POST", `/campaigns/${campaignId}/compress`, {});
    notice(r.level1 || r.level2 ? "已压缩较早的记录" : "记录还不够长，无需压缩", true);
    await loadCampaign();
  } finally { setBusy(false); }
}));

// Refresh the public log while players are playing.
poll = setInterval(() => {
  if (busy || !token || document.hidden) return;
  // While a scenario is being compiled, refresh the scenario list too.
  if (scenarios.some((s) => s.compileStatus === "running")) loadAll().catch(() => {});
  else if (campaignId) loadCampaign().catch(() => {});
}, 5000);

$("token").value = token;
setBusy(false);
if (token) run(loadAll);

// Model suggestions follow the provider each model field belongs to.
const syncers = [
  bindModelInput("sc-model", () => $("sc-provider").value),
  bindModelInput("cp-main", () => $("cp-provider").value),
  bindModelInput("cp-aux", () => $("cp-aux-provider").value || $("cp-provider").value),
  bindModelInput("md-main", () => $("md-provider").value),
  bindModelInput("md-aux", () => $("md-aux-provider").value || $("md-provider").value),
];
for (const id of ["sc-provider", "cp-provider", "cp-aux-provider", "md-provider", "md-aux-provider"])
  $(id).addEventListener("change", () => syncers.forEach((f) => f()));

// ---------------- model roles (defaults for compile / KP / summaries) ----------------
const ROLES = ["compile", "main", "aux"];
function renderRoles() {
  for (const role of ROLES) {
    $(`role-${role}-provider`).value = roles[role].provider || "";
    $(`role-${role}-model`).value = roles[role].model || "";
  }
  delete $("roles-form").dataset.touched;
}
/** Placeholders say what an empty model field will use. */
function roleHints() {
  const hint = (inputId, role, provider) => {
    const r = roles[role];
    const p = provider || r.provider;
    $(inputId).placeholder = r.model && p === r.provider ? `留空用分工默认：${r.model}` : "留空用接口默认";
  };
  hint("sc-model", "compile", $("sc-provider").value);
  hint("cp-main", "main", $("cp-provider").value);
  hint("cp-aux", "aux", $("cp-aux-provider").value || roles.aux.provider || $("cp-provider").value);
}
$("roles-form").addEventListener("input", () => { $("roles-form").dataset.touched = "1"; });
$("roles-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = {};
  for (const role of ROLES) body[role] = { provider: $(`role-${role}-provider`).value || null, model: $(`role-${role}-model`).value.trim() || null };
  run(async () => {
    roles = (await api("PUT", "/roles", body)).roles;
    renderRoles();
    roleHints();
    await loadAll();
    // Point the import and new-campaign forms at the new defaults.
    if (roles.compile.provider) $("sc-provider").value = roles.compile.provider;
    if (roles.main.provider) $("cp-provider").value = roles.main.provider;
    $("cp-aux-provider").value = "";
    roleHints();
    notice("模型分工已保存，导入剧本和开新团会默认使用这里的设置", true);
  });
});
for (const role of ROLES) {
  const sync = bindModelInput(`role-${role}-model`, () => $(`role-${role}-provider`).value);
  $(`role-${role}-provider`).addEventListener("change", sync);
}
for (const id of ["sc-provider", "cp-provider", "cp-aux-provider"]) $(id).addEventListener("change", roleHints);

// ---------------- spoiler review switch ----------------
$("review-enabled").addEventListener("change", () => {
  if (!campaignId) return;
  const enabled = $("review-enabled").checked;
  run(async () => {
    await api("PUT", `/campaigns/${campaignId}/review`, { enabled });
    notice(enabled ? "已开启防剧透审核" : "已关闭防剧透审核：KP 的回复将不经检查直接发出", true);
    await loadCampaign();
  });
});
