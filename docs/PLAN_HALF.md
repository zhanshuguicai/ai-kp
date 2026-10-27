# 第一半成品：模型主持的 QQ 文字团

本轮目标由用户于 2026-10-24 修正：输入 API、QQ 群聊、剧本与规则书，由模型理解对话/行动、调用 RD、续写剧情、维护主支线并帮助玩家和控制节奏。地图、完整数值战斗系统和角色养成放到后续。

## 产品边界与保留

- 默认入口改为自由主持工作台，旧版固定行动/剧情 DSL 保留在 `/legacy`，原存档不迁移、不覆写。
- 原文导入先支持粘贴和 UTF-8 TXT/Markdown；扫描 PDF/OCR、完整 D&D 规则自动执行不属于本半成品。
- AI 看见剧本秘密、规则和团记忆。模型判断行动与规则、选择掷骰表达式；服务端执行真实随机骰并返回结果，模型据此继续。玩家行动不经过预定义 affordance 白名单。
- 玩家只能收到公开回复和公开骰点；主持资料、私密记忆、模型原始工具参数只出现在本机管理台。
- 本机网页是管理与验收台，也可切换角色模拟多人群聊。真实 QQ 使用 OneBot v11 HTTP 事件与发送接口，需用户已有桥接器登录并配置。本轮不安装/登录 QQ，不向真实群发消息。
- 三家模型使用各自原生工具调用，单个主 KP 串行处理一桌，避免多模型人设漂移。优先试验 Claude Opus 5.5；常规成本候选 Sonnet 5.5；同题对照 GPT-6.1 Sol。推荐不等于已完成跑团实测。
- 未提供 API/QQ 凭证，因此自动化协议夹具和离线演示必须显著标注；不能宣称已完成真实 API 或 QQ 联调。

## 新接口约定（`/api/host`，均需 X-Admin-Token）

- GET `/api/host/config` -> `{ providers, qq }`，密钥只返回 configured 标志。
- POST `/api/host/config` -> 更新 `{ provider, model, apiKey?, baseUrl?, timeoutMs?, maxOutput? }`；模型可自由填写；密钥空白保留，明确删除才删除。QQ 配置另使用 `{ qq: { apiBaseUrl, accessToken?, secret?, enabled } }`。
- POST `/api/host/test` `{ provider, confirmBillable:true }` -> `{ ok, provider, model, message }`，明确真实计费请求，失败不改变当前团。
- GET `/api/host/materials` -> `{ materials }` 元信息；POST 同地址 `{ kind:'rules'|'scenario', title, text }` -> `{ material }`。
- POST `/api/host/rooms` `{ name, provider, rulesId, scenarioId, players:[{id,name,description?}] }` -> `{ room }`；允许素材为空使用内置原创文本示例，必须告知。
- GET `/api/host/rooms` -> `{ rooms }` 元信息；GET `/api/host/rooms/:id` -> `{ room }` 本机管理投影（含公开 events、rolls、memory 和私密 gmNotes）。
- POST `/api/host/rooms/:id/messages` `{ messageId, playerId, text, kind:'dialogue'|'action'|'ooc' }` -> `{ room, duplicate? }`；同 messageId 去重，同桌串行，失败记录清晰并保留已完成骰点，不重复掷骰。
- POST `/api/host/rooms/:id/start` `{ messageId }` -> `{ room }` 模型开场；POST `/api/host/rooms/:id/qq` `{ groupId, mode:'mention'|'all' }` 绑定群。
- POST `/api/host/qq/simulate` `{ roomId, userId, nickname, text, messageId }` -> `{ room, reply }`，显著离线。
- POST `/api/host/qq/events` 是桥接回调，独立校验签名/令牌，处理标准 group message，调用同一主持服务再 send_group_msg。忽略机器人自己/非绑定群/不满足触发模式消息，防重复。只回传公开文本与骰点，发送状态单独记录。

实施者可补充字段并需同步 `docs/HOST_API.md`，破坏性接口调整先通知另一实施者。

## 验收标准

1. 配置、原文资料、开团、输入对话/行动、显示回复和 RD、查看团记忆、重启恢复形成闭环。
2. 工具协议夹具证明：没有预设的新行动可触发 roll_dice，结果反馈模型，再产出剧情与主支线/事实记忆；三家工具协议均有检查。离线演示不得冒充真实智能。
3. 明确区分对话、行动、题外话；提示词约束不替玩家选择、不随意改写剧本真相、不泄露主持秘密，推动主线同时允许合理支线。
4. QQ 标准事件接入与发送在本地假桥接器完成端到端验证；真实账号联调列为待验收。
5. 同桌多人消息排队、消息去重、有限工具循环、失败可读、状态持久化；不把完整历史反复写入每条去重凭据。
6. 原有测试通过；新增核心验收检查通过；桌面和窄屏浏览器实际操作并留截图。没有真实 API 不得评价主持质量已达标。

## 派工

- HALF-CORE：gpt-6.1-sol / medium。需设计新的主持工具循环与三家协议、持久化和 QQ 接入，L 档缺少可机械实施的完整实现路径。写入 src、tests、examples 新样例、package 配置、README、.env.example、docs/HOST_API.md 和核心验证记录。禁止改 web、PLAN_HALF、ROUTING。
- HALF-UI：gpt-6.1-sol / medium。需设计可验收的新主流程和响应式界面。仅写 web 和界面验证记录。保留旧版 web 资源副本，以新文件 host.html/host.js/host.css 实现，旧 index/app/styles 留存。
- 本轮两者均首次执行，无升级或同档返修已用。中枢调研、接口协调和验收；开发由实施者完成。最多同时两位实施者。
