// AI KP platform console. All rendering uses textContent; nothing from the server is parsed as HTML.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const saved = (() => {
  try { return JSON.parse(sessionStorage.getItem("aikp-platform") || "{}"); } catch { return {}; }
})();
let token = saved.token || "";
let campaignId = saved.campaignId || "";
let systems = [];
let view = null;
let busy = false;

function remember() {
  try { sessionStorage.setItem("aikp-platform", JSON.stringify({ token, campaignId })); } catch {}
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
  for (const id of ["send", "start", "compress"]) $(id).disabled = b || !campaignId;
  $("send").textContent = b ? "KP 思考中…" : "发送";
}

const option = (value, label) => { const o = el("option", "", label); o.value = value; return o; };

// ---------------- loading ----------------
async function loadAll() {
  const [sys, prov, sc, cp] = await Promise.all([
    api("GET", "/systems"), api("GET", "/providers"), api("GET", "/scenarios"), api("GET", "/campaigns"),
  ]);
  systems = sys.systems;
  $("cp-system").replaceChildren(...systems.map((s) => option(s.id, s.name)));
  $("cp-provider").replaceChildren(...prov.providers.map((p) => option(p.id, `${p.id}${p.configured ? "" : "（未配置）"}`)));
  $("pv-id").replaceChildren(...prov.providers.filter((p) => p.id !== "demo").map((p) => option(p.id, p.id)));
  $("providers").replaceChildren(...prov.providers.map((p) => el("li", "", `${p.id}：${p.model}${p.reasoningEffort ? ` · 推理 ${p.reasoningEffort}` : ""} · ${p.configured ? "已配置" : "未配置"}`)));
  const auxOptions = () => [option("", "同主力供应商"), ...prov.providers.map((p) => option(p.id, p.id))];
  $("cp-aux-provider").replaceChildren(...auxOptions());
  $("md-aux-provider").replaceChildren(...auxOptions());
  $("cp-scenario").replaceChildren(...sc.scenarios.map((s) => option(s.id, s.title)));
  $("scenarios").replaceChildren(...sc.scenarios.map((s) => el("li", "", `${s.title} · ${s.characters} 字 · ${s.chunks} 段${s.hasBrief ? " · 有概要" : ""}`)));
  renderCampaigns(cp.campaigns);
  if (campaignId) await loadCampaign();
}

function renderCampaigns(list) {
  $("campaigns").replaceChildren(
    ...(list.length ? list.map((c) => {
      const li = el("li");
      const b = el("button", c.id === campaignId ? "active" : "", `${c.name} · ${c.systemId} · ${c.provider} · ${c.turns} 轮`);
      b.type = "button";
      b.onclick = () => run(async () => { campaignId = c.id; remember(); await loadCampaign(); renderCampaigns(list); });
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
  renderCampaign();
  setBusy(false);
}

// ---------------- rendering ----------------
const nameOf = (id) => view?.characters.find((c) => c.playerId === id)?.name || id;

function renderCampaign() {
  const { campaign, characters, state, summaries, events, scenario } = view;
  $("room-name").textContent = campaign.name;
  $("room-meta").textContent = `${scenario.title} · ${campaign.systemId} · ${campaign.provider} · ${characters.length} 位玩家`;
  $("msg-player").replaceChildren(...characters.map((c) => option(c.playerId, c.name)));

  const log = $("log");
  log.replaceChildren(...events.filter((e) => e.type !== "directive").map(renderEvent));
  log.scrollTop = log.scrollHeight;

  const last = [...events].reverse().find((e) => e.type === "directive");
  const ds = last?.data?.directives || [];
  $("directives").replaceChildren(...(ds.length ? ds.map((d) => el("div", "directive", `【${d.kind}】${d.reason}`)) : [el("span", "muted", "节奏正常")]));
  if (last?.data?.context) $("directives").append(el("div", "muted", `上下文约 ${last.data.context.total} tokens`));

  renderModels();
  renderState(state);
  $("summaries").replaceChildren(
    ...(summaries.length ? summaries.map((s) => el("p", "", `${s.level === 2 ? "【章节】" : "【片段】"}${$("show-kp").checked ? s.kpText : s.publicText}`)) : [el("span", "muted", "尚无（记录变长后会自动压缩）")]),
  );
  renderSheets(characters, campaign.systemId);
}

function renderModels() {
  const m = view.models;
  $("models-info").replaceChildren(
    ...(m
      ? [el("div", "", `主力：${m.main.provider} · ${m.main.model}`), el("div", "", `辅助：${m.aux.provider} · ${m.aux.model}`)]
      : [el("div", "", "模型配置无效，请检查供应商设置")]),
  );
  const s = view.campaign.settings.models;
  $("md-main").value = s.main || "";
  $("md-aux-provider").value = s.auxProvider || "";
  $("md-aux").value = s.auxModel || "";
  const u = view.usage;
  const k = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : String(n));
  $("usage").textContent = u.turns
    ? `${u.turns} 轮 · 输入 ${k(u.input)}（缓存 ${u.input ? Math.round((u.cached / u.input) * 100) : 0}%）· 输出 ${k(u.output)}${u.cost !== null ? ` · ${u.cost.toFixed(3)}` : ""}`
    : "尚无用量";
}

function renderEvent(e) {
  const hidden = e.visibility !== "public";
  const cls = e.type === "whisper" ? "whisper" : hidden ? "hidden-info" : e.type;
  const li = el("li", cls);
  const label = {
    player: `${e.actor ? nameOf(e.actor) : "主持请求"}${e.data?.kind ? ` · ${e.data.kind}` : ""}`,
    kp: "KP",
    roll: hidden ? "暗骰（仅 KP）" : "骰点",
    state: hidden ? "状态（仅 KP）" : "",
    note: "KP 笔记",
    whisper: `私聊 → ${nameOf(e.actor)}`,
    error: "错误",
  }[e.type] ?? e.type;
  if (label) li.append(el("div", "who", label));
  li.append(el("div", "", e.text));
  return li;
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

function renderState(s) {
  const kp = $("show-kp").checked;
  const parts = [
    el("p", "", `场景：${s.scene.name}${s.scene.description ? ` —— ${s.scene.description}` : ""} · 紧张度 ${s.tension}/5`),
    list("剧情线", s.threads.map((t) => `[${t.kind === "main" ? "主" : "支"}] ${t.title} · ${t.status}`)),
    list("线索", s.clues.map((c) => `${c.text}（第${c.turn}轮）`)),
    list("NPC", Object.entries(s.npcs).map(([n, v]) => `${n}：${v.status}${v.attitude ? ` · ${v.attitude}` : ""}`)),
  ];
  if (kp) {
    parts.push(list("威胁时钟（KP）", Object.entries(s.clocks).map(([n, c]) => `${n} ${c.filled}/${c.size}${c.note ? ` · ${c.note}` : ""}`)));
    parts.push(list("KP 笔记", s.kpNotes));
  }
  $("state").replaceChildren(...parts);
}

function renderSheets(characters, systemId) {
  const example = systems.find((s) => s.id === systemId)?.exampleSheet;
  $("sheets").replaceChildren(...characters.map((c) => {
    const box = el("div", "sheet");
    box.append(el("strong", "", c.name));
    const ta = el("textarea");
    ta.rows = 5;
    ta.value = c.sheet ? JSON.stringify(c.sheet, null, 1) : "";
    ta.placeholder = example ? `示例：${JSON.stringify(example)}` : "JSON 角色卡";
    const b = el("button", "", "保存角色卡");
    b.type = "button";
    b.onclick = () => run(async () => {
      const sheet = ta.value.trim() ? JSON.parse(ta.value) : null;
      await api("PUT", `/campaigns/${campaignId}/characters/${encodeURIComponent(c.playerId)}`, { name: c.name, sheet });
      notice(`${c.name} 的角色卡已保存`, true);
      await loadCampaign();
    });
    box.append(ta, b);
    return box;
  }));
}

// ---------------- actions ----------------
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

async function playTurn(path, body) {
  setBusy(true);
  try {
    const r = await api("POST", `/campaigns/${campaignId}/${path}`, body);
    if (r.turn.status === "failed") notice(r.turn.error || "本轮失败");
    await loadAll(); // also refreshes turn counts in the campaign list
    return r;
  } finally {
    setBusy(false);
  }
}

$("token-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  remember();
  run(loadAll);
});

$("sc-file").addEventListener("change", async () => {
  const f = $("sc-file").files[0];
  if (!f) return;
  $("sc-text").value = await f.text();
  if (!$("sc-title").value) $("sc-title").value = f.name.replace(/\.(txt|md)$/i, "");
});

$("scenario-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    const r = await api("POST", "/scenarios", { title: $("sc-title").value, text: $("sc-text").value, brief: $("sc-brief").value || undefined });
    notice(`已导入《${r.scenario.title}》：${r.scenario.characters} 字，切成 ${r.scenario.chunks} 段`, true);
    $("scenario-form").reset();
    await loadAll();
  });
});

$("campaign-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(async () => {
    const players = $("cp-players").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, ...rest] = l.split(/[,，]/);
      return { id: id.trim(), name: (rest.join(",").trim() || id.trim()) };
    });
    const r = await api("POST", "/campaigns", {
      name: $("cp-name").value, scenarioId: $("cp-scenario").value, systemId: $("cp-system").value,
      provider: $("cp-provider").value, players,
      models: { main: $("cp-main").value.trim() || null, auxProvider: $("cp-aux-provider").value || null, auxModel: $("cp-aux").value.trim() || null },
    });
    campaignId = r.campaign.id;
    remember();
    notice("团已建立，可以点「开场」", true);
    await loadAll();
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

$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy || !campaignId) return;
  const text = $("msg-text").value.trim();
  if (!text) return;
  run(async () => {
    await playTurn("messages", { messageId: newId(), playerId: $("msg-player").value, kind: $("msg-kind").value, text });
    $("msg-text").value = "";
  });
});
$("msg-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) $("message-form").requestSubmit();
});
$("start").addEventListener("click", () => run(() => playTurn("start", { messageId: newId() })));
$("compress").addEventListener("click", () => run(async () => {
  setBusy(true);
  try { await api("POST", `/campaigns/${campaignId}/compress`, {}); notice("已压缩较早的记录", true); await loadCampaign(); }
  finally { setBusy(false); }
}));
$("show-kp").addEventListener("change", () => {
  $("log").classList.toggle("hide-kp", !$("show-kp").checked);
  if (view) renderCampaign();
});

$("token").value = token;
setBusy(false);
if (token) run(loadAll);
