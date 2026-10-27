# AI KP

> **新平台（开发中）**：支持接入剧本、自动压缩上下文、按剧本与玩家行动调整节奏的 KP 平台，内置 7 种规则。
> **第一次使用请看 [使用说明](docs/使用说明.md)**（从安装到开团，一步一步）。
> **版权所有，仅供查看**：未经许可不得复制、修改、分发或用于其他项目，详见 [LICENSE](LICENSE)。
> 启动：`npm install && npm run build && npm run platform`，打开 http://127.0.0.1:3100 。设计与进度见 [docs/PLATFORM_DESIGN.md](docs/PLATFORM_DESIGN.md)。
> 下面是旧版（v0.3-half）的说明，新平台稳定后会移除。

# AI KP 0.3 第一半成品：模型自由主持

输入模型 API、规则原文和剧本原文，由一个主 KP 理解玩家发言、决定检定、调用服务端真实骰、续写公开剧情并维护团记忆。新流程独立于旧固定动作/剧情 DSL；旧版与原数据保留在 `/legacy`。

当前自动验收证明本地闭环与三家工具协议夹具。没有配置真实 API key，没有进行真实模型计费调用、主持质量评测或真实 QQ 群联调。`demo` 是显著标注的**离线协议演示，固定脚本，无智能承诺**。

## 启动与本地演示

要求 Node.js 22。项目目录执行：

```powershell
npm install
npm run build
npm start
```

打开 [本地工作台](http://127.0.0.1:3000)。首次启动生成 `data/admin-token.txt`；把令牌填入管理台。服务只监听本机。管理台包括主持私密资料，请勿作为玩家共享屏幕。

1. 可直接使用 `demo`、内置原创《雾港停钟》规则/剧本建立一桌，或粘贴/导入 UTF-8 TXT/Markdown。
2. 添加玩家，选择对话、行动或题外话，发送任意新行动，例如“我把雨伞当作帆，穿过积水巷道”。
3. 演示器对行动固定调用 `1d20`，骰点由服务端 `crypto.randomInt` 真实生成；后续文本固定，只验证骰→工具回传→记忆→公开回复流程。
4. 查看公开团记忆、主支线/NPC/节奏、主持私密记忆与公开骰点；重启后恢复。

新状态单独存于 `data/free-host/host-state.json`，旧存档路径不迁移。只允许单个 Node 进程使用一个数据目录。文件包括 API key、QQ secret 与私密剧本，按本机敏感资料管理。

## 连接真实模型

在本机管理台保存 API key、模型名与接口根地址，或复制 `.env.example` 为 `.env` 后配置环境变量。保存的值优先于环境变量；key 留空保留，明确删除只移除本地保存值，已有环境变量仍有效。GET 配置只返回 configured 状态，不返回 key。不会自动回落演示或另一家模型。

- Anthropic Messages：默认 `claude-opus-5-5`，质量试验候选；可填 `claude-sonnet-5-5`。保留完整 thinking/signature 工具回传，不强制工具、不禁用 thinking。
- OpenAI Responses：默认 `gpt-6.1-sol`，`reasoning.effort=medium`。
- Gemini Interactions：默认 `gemini-4-argon`，`store:false`，完整保留本轮原生 steps 并回传独立 function_result。

“测试 API”按钮会发出真实计费请求，测试只允许公开连接确认，不修改团。模型名与可用性以账号实际权限为准。未配置会明确报错。通过配置测试也不代表主持质量已验收。

原文每份上限 200000 字符、单条玩家输入上限 6000 字符，超过会明确拒绝，不静默截断。原文完整存储；模型起初看每份前12000字符，并可调用 `query_materials` 按字符偏移或关键词继续读取。主持可调用 `roll_dice`、`remember_campaign`、`update_progress`、`query_materials`、`finish_turn`。最终只有 `finish_turn.publicReply` 与公开骰点发给玩家；原始模型思考/工具参数不直接发布。规则与行动由模型判断，服务不提供完整 D&D 数值引擎，也无法保证模型不会误判或在自然语言中泄漏秘密，真实使用需主持核验。

同桌消息串行处理，最多8轮、每轮最多12个工具。messageId 一经处理就去重，包括失败；失败后保留已完成骰点与记忆。同ID重发只返回当前房间，不重跑。检查错误后用新ID发新一轮继续。服务重启中断轮次会标为失败，不自动重掷。

## QQ OneBot v11 HTTP 桥接

需要用户已有、已登录的 OneBot v11 桥接器。本项目没有安装或登录 QQ，也未向任何真实群发信。

在管理台启用 QQ、填写桥接 API 地址、独立 accessToken 和独立 secret，绑定群号与 mention/all 模式。让桥接器 HTTP POST 上报到 `http://127.0.0.1:3000/api/host/qq/events`；配置共享 secret。回调用原始请求体的 HMAC-SHA1 (`X-Signature: sha1=...`) 验签，不使用管理令牌。发送使用 `POST /send_group_msg`、`Authorization: Bearer accessToken`、`auto_escape:true`，同时检查 HTTP 和 OneBot status/retcode。服务默认仅接受本机桥接器。

回调在持久化入队后立即确认，模型后台处理。群发言内部 `kind:auto` 由模型分辨对话/行动/题外话；提及、机器人自身、非绑定群和重复事件有过滤。只有公开回复、公开错误说明和公开骰点进入群发送体。发送状态见团的 deliveries：`bridge-ok` 仅表示桥接API返回成功，`accepted-async` 仅已提交，`failed`/`unknown-after-restart` 不保证送达，不自动重复发信或重跑主持。

离线 QQ 模拟按钮不调用真实发送。自动测试另有本地假桥接器，验证真实 HTTP 接收→签名→主持→send_group_msg，不证明账号联调。

## 验证与文档

```powershell
npm run typecheck
npm test
```

新接口见 [HOST_API](docs/HOST_API.md)，核心验收见 [VERIFICATION_HALF_CORE](docs/VERIFICATION_HALF_CORE.md)，范围见 [PLAN_HALF](docs/PLAN_HALF.md)。界面截图与浏览器验收由主会话记录。扫描PDF/OCR、地图、完整战斗/角色养成、多进程部署放到后续。

旧版操作、HTTP契约与验证记录仍见 [HTTP_API](docs/HTTP_API.md)、[ARCHITECTURE](docs/ARCHITECTURE.md)、[VERIFICATION_V02](docs/VERIFICATION_V02.md)，在 `/legacy` 使用，不能代表新自由主持流程。
