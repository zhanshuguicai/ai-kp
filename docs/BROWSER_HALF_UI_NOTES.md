# HALF-UI 界面交付与静态自检

日期：2026-10-24。实施范围仅为 `web/host.html`、`web/host.js`、`web/host.css` 与本记录。旧 `web/index.html`、`web/app.js`、`web/styles.css` 未改动。服务入口 `/`、`/legacy` 的路由由 HALF-CORE 实施者接线。

## 已实施

- 余烬酒馆风格，本机主持管理台的剧透提示常驻顶部；主流程为令牌、模型、原文、多人开团、宽幅群聊与主持记录。
- API provider/model/base URL/key 可填写与保存；model 没有写死推荐值。真实模型按服务器 `configured` 回显供选择；未配置不能在开团下拉选用。保存凭证不显示为连接成功。
- 密钥输入为 password；管理令牌只进入当前标签页 sessionStorage。API key、QQ accessToken、secret 不进入任何浏览器持久化字段，提交完成或失败后清空相应输入。服务器返回凭证配置标志而非密钥。
- 粘贴 / UTF-8 TXT / Markdown 导入原文，无 JSON 前置要求。规则 / 剧本分别选择，内置原创素材有明确告知。
- 内置示例按钮填入固定脚本演示与两位玩家，随后创建团。开团表单强制至少两位不同 ID 玩家，也可增加玩家。可恢复服务器团、切换当前玩家、刷新团记录；同标签页重载自动恢复令牌与团绑定。
- dialogue/action/ooc，Enter 发送、Shift+Enter 换行、输入法组合事件保护。发送失败保留草稿和消息类型。处理期间禁用重复提交。每团未确认的消息、开场、QQ 模拟请求 ID 与必要 snapshot 在请求发出前写入 sessionStorage；重载或切换团后，相同未编辑内容复用原 ID，明确收到 complete 才清除。修改内容、类型或玩家后创建新一轮；后端失败回执和已完成骰点不会重跑。
- 公开剧情、RD、主线 / 支线 / 事实 / NPC / 节奏记忆、主持私密笔记分别呈现。工具只呈现名称与状态（如果后端将来提供），当前按服务端骰点数量给出摘要，无原始参数泄漏到聊天。
- OneBot URL / accessToken / secret / enabled，当前团群号及 mention/all 绑定，HMAC-SHA1 回调地址说明，本地 QQ 事件模拟。发送状态区分桥接成功、异步接收、失败、重启后未知；真实账号待联调标识始终保留。
- 固定脚本演示在开团区、当前团聊天前均明确提示“不代表真实模型智能”。真实连接测试按钮直接说明产生一次 API 请求，不自动进行计费测试。没有每次行动的确认步骤。
- CSS 提供 1150/850/560px 布局断点、窄屏单列聊天、可见键盘焦点和 reduced-motion 支持。语义表单标签、状态 live region、聊天 log；API 文本均通过 textContent 设置。

## 与 HALF-CORE 对齐的字段

- GET config：`providers:[{id,model,baseUrl,configured,status,...}]`；离线 provider 为 `demo`；qq 包含 enabled/apiBaseUrl/accessTokenConfigured/secretConfigured/callbackPath。
- POST config：`{provider,model,baseUrl?,apiKey?,deleteApiKey?}` 或 `{qq:{apiBaseUrl,accessToken?,secret?,enabled}}`。空密钥省略保留，空 base URL 省略保留。
- POST test：`{provider,confirmBillable:true}`，只测试服务器已保存配置。
- 素材 GET/POST、rooms GET/POST、room GET、messages/start/qq POST 均按 PLAN_HALF 接口。
- room：events 使用 type/text/playerId/kind/at；rolls 使用 expression/values/total/reason；memory 使用 mainQuest/sideQuests/facts/npcs/pace；gmNotes 为字符串列表。
- `receipts[messageId].status` 成功为 `complete`、失败为 `failed`；失败的 error/code 只读取必要提示。HTTP 200 也检查失败回执。同 ID 不重新运行；编辑草稿后是新一轮。
- 本地模拟回执键为 `qq-sim:${messageId}`，reply 是公开回传文本。`room.deliveries` 读取 sending/bridge-ok/accepted-async/failed/unknown-after-restart。
- 所有 `/api/host` 管理请求携带 `X-Admin-Token`；回调事件由 OneBot 桥接器直接访问，浏览器管理台不模拟签名请求。

## 静态自检结果

- `node --check web/host.js`：PASS（退出码 0）。
- HTML/JS ID 交叉检查：73 个 HTML ID，66 个直接 JS 引用 ID；缺失 0、重复 0。
- 搜索危险 HTML 写入：无 innerHTML / insertAdjacentHTML / document.write。所有服务返回文本由 textContent 或文本 Option 节点呈现。
- 存储值审阅：只包含 token、roomId、playerId、按团草稿（text/kind/playerId）及按团未确认 submissions（message/start/qq 的 messageId/snapshot）；无 API key / QQ token / secret / GM 笔记。旧版字符串草稿仍能恢复，类型按 dialogue 兼容。
- 接口调用与当前 `src/host.ts`、`src/server.ts` 做了只读核对，包括 complete 回执、qq-sim 前缀、deliveries、6000 字消息限制以及 5700 默认桥接端口。

## 验证边界

本实施者未启动后台服务，未操作真实 API 或 QQ。静态检查不证明页面实际交互、手机布局、重载恢复或网络错误路径已通过。主会话负责桌面 / 窄屏浏览器实际验收及截图，并将发现返给本实施者修复。此处不宣称真实模型主持质量或真实 QQ 账号联调通过。

当前页面由“刷新”按钮读取其他来源新增的团记录，没有自动轮询。若浏览器端需要观察真实群流量，手动刷新当前团即可。

## 第一次定向返修：重载后的去重边界

主会话实际浏览器已通过原文粘贴导入、自选素材开团、双人行动 / 对话、RD、QQ 模拟、重载团记录；发现 OOC 草稿重载后变成 dialogue。源码复核也发现 pending ID 仅留在内存，响应丢失后重载可能生成新 ID。该问题已在本次返修修复（仅 host.js 与本记录）。

- 草稿持久化 text/kind/playerId，并兼容旧字符串格式。type change 与 player change 都及时保存。
- 每个团独立保存三类未确认提交 ID 和最小输入 snapshot。发送前必须成功保存，若浏览器会话存储写入失败则停止本次请求，不冒险发送失去去重凭据的行动。
- 响应丢失、网络错误、主持 failed 回执均保留 ID；重载 / 切换回来复用。主持 failed 永不以同 ID 重跑，必须修改内容 / 类型 / 玩家来发起新一轮。开场 failed 保留原 ID，再点开场也不会重跑，玩家可发送新的对话继续。
- 只有明确的 `receipt.status === 'complete'` 清除对应 pending。服务器重载后 GET 已显示成功，也先保留凭据；重新提交同 ID 由服务器返回 duplicate，确认 complete 后再清除。这覆盖“服务器已掷骰但 HTTP 响应丢失”的情况。

针对性轻量 DOM / 会话状态测试以 Node VM 加载实际 host.js，复用 sessionStorage 模拟重载。模拟服务器先写 complete 与骰点，再丢失响应；下一次请求按相同 messageId 去重。测试未使用真实服务、API 或 QQ，不能替代真实浏览器验收。

```text
PASS message: OOC + draft restore, room switch, same ID after lost response, one roll, clear only on complete
PASS edit: changing kind starts a new message ID
PASS start: same ID after reload and lost response; no additional roll
PASS QQ simulate: snapshot + ID restore, no additional roll, clear on complete
PASS storage: persisted before POST; no API key or GM notes; legacy string draft compatible
```

`node --check web/host.js` 再次退出 0。真实浏览器 OOC 类型恢复由主会话复验；没有新增自动轮询或其他功能。
