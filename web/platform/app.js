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
  const [sys, prov, sc, cp] = await Promise.all([
    api("GET", "/systems"), api("GET", "/providers"), api("GET", "/scenarios"), api("GET", "/campaigns"),
  ]);
  $("cp-system").replaceChildren(...sys.systems.map((s) => option(s.id, s.name)));
  $("cp-provider").replaceChildren(...prov.providers.map((p) => option(p.id, `${p.id}${p.configured ? "" : "（未配置）"}`)));
  $("pv-id").replaceChildren(...prov.providers.filter((p) => p.id !== "demo").map((p) => option(p.id, p.id)));
  $("providers").replaceChildren(...prov.providers.map((p) => el("li", "", `${p.id}：${p.model}${p.reasoningEffort ? ` · 推理 ${p.reasoningEffort}` : ""} · ${p.configured ? "已配置" : "未配置"}`)));
  const auxOptions = () => [option("", "同主力供应商"), ...prov.providers.map((p) => option(p.id, p.id))];
  $("cp-aux-provider").replaceChildren(...auxOptions());
  $("md-aux-provider").replaceChildren(...auxOptions());
  scenarios = sc.scenarios;
  const keep = $("cp-scenario").value;
  $("cp-scenario").replaceChildren(...scenarios.map((s) => option(s.id, `${s.title}${s.compileStatus === "done" ? "" : `（${STATUS[s.compileStatus]}）`}`)));
  if (keep && scenarios.some((s) => s.id === keep)) $("cp-scenario").value = keep;
  const keepProvider = $("sc-provider").value;
  $("sc-provider").replaceChildren(...prov.providers.map((p) => option(p.id, `${p.id}${p.configured ? "" : "（未配置）"}`)));
  $("sc-provider").value = keepProvider || prov.providers.find((p) => p.configured && p.id !== "demo")?.id || "demo";
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

$("provider-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    const body = {};
    if ($("pv-key").value.trim()) body.apiKey = $("pv-key").value.trim();
    if ($("pv-model").value.trim()) body.model = $("pv-model").value.trim();
    if ($("pv-url").value.trim()) body.baseUrl = $("pv-url").value.trim();
    if ($("pv-effort").value) body.reasoningEffort = $("pv-effort").value;
    await api("POST", `/providers/${$("pv-id").value}`, body);
    $("pv-key").value = "";
    notice("模型设置已保存", true);
    await loadAll();
  });
});

$("models-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!campaignId) return;
  run(async () => {
    await api("PUT", `/campaigns/${campaignId}/models`, {
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
