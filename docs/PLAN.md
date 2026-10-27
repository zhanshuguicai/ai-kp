# AI KP 框架：本轮范围与验收

用户目标：在本地网页中运行多人文字跑团，AI 独立主持。规则、剧本、模型 API、网页与 QQ 均可以通过接口接入。偏好 D&D 类战斗冒险，但本轮不宣称实现完整 D&D。

## 已确定的设计

- 新建独立目录 `C:/Users/38365/CodexProjects/ai-kp`，不修改其他项目。不发布到公网，不读取或使用其他项目的密钥。
- Node.js 22.13.1 + TypeScript 后台；网页使用无构建依赖的 HTML/CSS/JS，由同一后台提供。默认仅监听 127.0.0.1。
- 规则与剧本采用版本化 JSON 包，提供校验、导入、样例与 JSON Schema。规则正文与规则执行能力分开；未实现机制要明确报告。
- 一份权威游戏状态。AI 只形成叙述与建议，骰子、资源、行动是否合法及落盘由后台执行。持久化独立于模型对话状态。
- 模型统一接口：Mock、OpenAI Responses、Anthropic Messages、Gemini Interactions。真实模型仅实现适配与受控模拟测试，本轮不花费用户 API 额度；所有密钥来自服务器环境变量，网页与日志不返回密钥。
- QQ 统一输入输出与身份绑定接口，提供本地模拟验证；真实机器人连接、应用权限、网络与凭证联调留待配置。不得把模拟标成已连 QQ。
- 单一模块接口还应覆盖：身份、持久化、骰子、资料导入/检索、地图/素材、工具执行及未来渠道；对未实现项给出清晰状态与接入说明，避免无行为空壳伪装成支持。
- 玩家只能操作自己的角色；公共、个人、主持秘密分别投影。模型公共叙述上下文不注入未公开剧本秘密。房主令牌与玩家令牌隔离。
- 同场操作串行提交，版本冲突显式返回 409；requestId 幂等防止重复掷骰和扣资源。聊天/探索与战斗模式明确区分。

## HTTP 界面约定（交给实现者保持语义，详细 DTO 由其固化在 docs/HTTP_API.md）

- GET `/api/health`、GET `/api/catalog`：健康及无秘密的规则/剧本/模型目录。
- POST `/api/sessions`：使用 `X-Admin-Token` 创建。返回房间、会话 ownerToken 与 inviteCode。
- POST `/api/sessions/:id/join`：用 inviteCode 加入，返回 playerToken、actorId、过滤后的 session。
- GET `/api/sessions/:id`、GET `/api/sessions/:id/events`：会话 Bearer token，按身份过滤。
- POST `/api/sessions/:id/actions`：会话 Bearer token，`{requestId, expectedVersion, kind, payload}`；kind 至少 say/check/attack/end_turn。请求 actor 不可伪造身份。
- POST `/api/sessions/:id/control`：房主暂停/恢复/开始演示战斗；明确记录版本。
- GET `/api/sessions/:id/export`：仅房主；界面说明含剧本秘密。存档恢复应有受控入口与验证。
- POST `/api/packages/validate`、POST `/api/packages/import`：X-Admin-Token，仅 JSON 包；导入不覆盖同版包或活动会话内容。
- GET `/api/config`：X-Admin-Token，返回脱敏的 provider 配置/就绪状态。
- QQ 身份绑定与模拟入口应需要管理或房主鉴权，并能处理重复事件；详细路径由后端实现者文档化并告知前端。
- 所有错误使用稳定 code 与中文 message，不能把上游响应体、堆栈或密钥直接返回浏览器。拒绝跨域请求，无默认开放 CORS。

## 网页范围

中文应用工作台：侧栏冒险/接口状态、开团或加入、中央主持记录与自然语言输入、右侧角色/回合/地图或位置/个人信息、管理面板导入规则与剧本及查看 API 接入状态。明确显示“模拟 KP”或真实 provider；未实现控件不得假装可用。支持窄屏、键盘操作、请求中状态与错误恢复。不需要外部图片。

## 验收

1. 无 API key 可安装、类型检查、构建并启动；浏览器能开演示团、加入、提交行动、看到记录及状态变化。
2. 自有简化 d20 规则样例与原创短篇剧本；规则覆盖清单明确。
3. 合法检定/攻击可结算；越权、重复请求、版本冲突、资源不足/非本人回合被正确处理。
4. 秘密不进入公共 catalog、公共投影或公共模型输入；个人事件只对授权者可见。
5. 重启能恢复状态；导出/恢复验证结构与引用，不能成为读取其他本机文件的入口。
6. 三个真实 provider 的请求/响应适配有模拟 transport 测试，覆盖错误/拒绝/截断/非结构化返回与超时；未配置不自动转用其他付费模型。
7. QQ 标准化事件模拟从绑定身份到提交行动可演示，重试不重复结算；真实接入保持待联调状态。
8. 有中文 README、模块接口、HTTP 界面与扩展接入说明；检查结果与未验证项如实记录。

## 文件所有权

- backend worker：除 `web/` 和本计划/路由记录以外的项目文件，包含 package、src、tests、examples、schemas、README 与技术文档。负责依赖安装与整体验证。
- frontend worker：仅 `web/`；通过 HTTP 界面接入，不自行增加 npm 包或改后台。需要契约调整时先回报。
- 中枢：本计划、路由记录、调度与验收；不接管产品实现。

## 当前路由

后端与前端都需独立设计与集成，L 档的既定方案条件不满足，首发 S：`gpt-6.1-sol / medium`。最多两个并行执行者。每个节点首发一轮，尚无返修与升级。
