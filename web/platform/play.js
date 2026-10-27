// Player page. The invite token arrives in the URL fragment (never sent to the server as part of
// the URL), is kept in sessionStorage, and then removed from the address bar.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const KEY = "aikp-player-token";
let token = "";
try { token = sessionStorage.getItem(KEY) || ""; } catch {}
const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
if (fromHash) {
  token = fromHash;
  try { sessionStorage.setItem(KEY, token); } catch {}
  history.replaceState(null, "", location.pathname);
}

let view = null;
let busy = false;
let sheetDirty = false;

function notice(text, ok = false) {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
  $("notice").className = ok ? "notice ok" : "notice";
}

async function api(method, path, body) {
  if (!token) throw new Error("请使用组织者发给你的邀请链接打开本页");
  let res;
  try {
    res = await fetch(`/api/v1/play${path}`, {
      method,
      headers: { "X-Player-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    $("status").textContent = "连接中断";
    $("status").className = "badge bad";
    throw new Error("连不上服务，请稍后再试；你的输入还在");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { $("status").textContent = "链接无效"; $("status").className = "badge bad"; }
    throw new Error(data.error?.message || `请求失败（HTTP ${res.status}）`);
  }
  $("status").textContent = "已连接";
  $("status").className = "badge good";
  return data;
}
async function run(fn) {
  try { notice(""); await fn(); } catch (e) { notice(e.message || String(e)); }
}

async function load() {
  view = await api("GET", "/");
  render();
}

const nameOf = (id) => view?.players.find((p) => p.id === id)?.name || id;

function render() {
  $("title").textContent = view.campaign.name;
  document.title = `${view.campaign.name} · AI KP`;
  $("me").textContent = `你是 ${view.me.name} · ${view.me.systemName}`;

  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...view.events.map((e) => {
    const mine = e.type === "player" && e.actor === view.me.id;
    const li = el("li", `${e.type}${mine ? " mine" : ""}`);
    const label = {
      player: `${e.actor ? nameOf(e.actor) : "开场"}${mine ? "（你）" : ""}`,
      kp: "KP",
      roll: "骰点",
      whisper: "KP 悄悄告诉你",
      error: "出错了",
      system: "系统",
    }[e.type] ?? "";
    if (label) li.append(el("div", "who", label));
    li.append(el("div", "", e.text));
    return li;
  }));
  if (atBottom) log.scrollTop = log.scrollHeight;

  const s = view.state;
  const part = (title, items) => {
    const box = el("div");
    box.append(el("strong", "", title));
    if (!items.length) { box.append(el("div", "muted", "—")); return box; }
    const ul = el("ul");
    ul.append(...items.map((t) => el("li", "", t)));
    box.append(ul);
    return box;
  };
  $("state").replaceChildren(
    el("p", "", `场景：${s.scene.name}${s.scene.description ? ` —— ${s.scene.description}` : ""}`),
    part("目标", s.threads.map((t) => `${t.kind === "main" ? "【主线】" : "【支线】"}${t.title}${t.status === "open" ? "" : t.status === "done" ? "（完成）" : "（失败）"}`)),
    part("已知线索", s.clues.map((c) => c.text)),
    part("人物", Object.entries(s.npcs).map(([n, v]) => `${n}：${v.status}${v.attitude ? ` · ${v.attitude}` : ""}`)),
  );
  $("summaries").replaceChildren(
    ...(view.summaries.length ? view.summaries.map((x) => el("p", "", x.text)) : [el("span", "muted", "尚无（团进行得久了会自动生成）")]),
  );

  $("sheet-hint").textContent = `${view.me.systemName} 的角色卡（JSON）。没有角色卡也能玩，KP 会临时给出数值。`;
  if (!sheetDirty && document.activeElement !== $("sheet"))
    $("sheet").value = view.me.sheet ? JSON.stringify(view.me.sheet, null, 1) : "";
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  const text = $("msg-text").value.trim();
  if (!text) return;
  busy = true;
  $("send").disabled = true;
  $("send").textContent = "KP 思考中…";
  run(async () => {
    const r = await api("POST", "/messages", { messageId: newId(), kind: $("msg-kind").value, text });
    if (r.turn.status === "failed") notice(r.turn.error || "这一轮失败了，请再发一次");
    else $("msg-text").value = "";
    await load();
  }).finally(() => {
    busy = false;
    $("send").disabled = false;
    $("send").textContent = "发送";
  });
});
$("msg-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) $("message-form").requestSubmit();
});

$("sheet").addEventListener("input", () => { sheetDirty = true; });
$("sheet-example").addEventListener("click", () => {
  $("sheet").value = JSON.stringify(view.me.exampleSheet, null, 1);
  sheetDirty = true;
});
$("sheet-save").addEventListener("click", () => run(async () => {
  let sheet = null;
  if ($("sheet").value.trim()) {
    try { sheet = JSON.parse($("sheet").value); } catch { throw new Error("角色卡不是合法的 JSON"); }
  }
  await api("PUT", "/sheet", { sheet });
  sheetDirty = false;
  notice("角色卡已保存", true);
  await load();
}));

setInterval(() => {
  if (!busy && token && !document.hidden) load().catch(() => {});
}, 4000);

if (token) run(load);
else notice("请使用组织者发给你的邀请链接打开本页");
