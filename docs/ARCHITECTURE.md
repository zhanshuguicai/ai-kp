# v0.2 架构与扩展边界

`contracts.ts` 定义 DTO/包/Decision；`game.ts` 负责身份、版本、幂等、事务、应用服务与公开投影；`rules.ts` 保留简化 d20 执行器和扩展 registry。`director.ts` 提供本地中文演示解释器及 Decision 校验；`providers.ts` 负责供应商 interpret/narrate 和受限 JSON；`story.ts` 执行声明式条件/效果；`adventure.ts` 对应 examples/lantern-vault-v2.json。HTTP 层只做路由/鉴权/静态文件。

## 主持事务

say 先写入克隆状态的公开发言，再以公开上下文解释为 dialogue/action/clarification/proposal。明确动作必须与服务器公开 affordance 中的 kind+payload 完全匹配；模型不能自己制造 DC、成本、物品、旗标或目标。问句/条件/引用/过去或讨论表达即使被模型误判为 action，也由服务端保守降为澄清；真实 provider 仍会先进行语义解析，正常 dialogue 可以回答。

action 经玩家身份、存活状态、回合、资源、可达性、交互前置校验后执行规则和剧情触发。随后 narrate 只读取公开事件。只有解释、规则、触发和叙述全部成功才持久化；模型错误、超时、非法输出或触发超限不会部分扣资源或发物品。骰子在事务失败时可能已经消耗随机数，但不会留下任何权威状态变更。手动动作走相同规则/剧情约束；自由 check 不产生剧情触发。

pending 保存随机ID、actorId、产生版本、action与message；确认必须同时匹配玩家、ID、当前版本。其他成功操作、加入、暂停/恢复都会过期；取消/确认清空。新requestId重放失效提案返回INVALID_PROPOSAL；完全相同requestId的网络重试仍返回原幂等结果，不再次执行。恢复为新session时清除pending，进程重启保留未过期pending。

## 声明式剧情

ScenarioPackage.story 为可选字段；v1包没有它，自动以原场景 links 初始化路径，保持旧角色/位置/事件。v2包含声明 flags/items/objectives/endings/encounters/initialPaths/interactions/triggers。所有内容仅数据，不 eval、不加载JS、不开放任意模型工具。

条件为全体AND：scene、target、action、flag(boolean)、item(至少数量)、check(成功/失败)、enemy(击败/未击败)、status。target来自当前已执行动作；check只由剧本交互检定产生。效果：设旗标、增减物品、公共/个人揭示、解锁有向路径、完成目标、开始/结束遭遇、设置结局。私密reveal的actor是当前合法行动者，不允许包指定其他人的ID。所有目标/物品/旗标/敌人/场景/结局引用在导入时检查。

触发器按包数组顺序执行至固定点，每个trigger每次动作最多一次；once=true另持久化fired，跨重启/恢复不重复。每事务最多64次触发，超限整个事务失败。循环依赖因此有界，不允许无限刷物品；once=false可在下一动作再次符合。第一个结局立即终止余下效果和触发，禁止覆盖。副作用存于同一State快照。

## 投影与包版本

SessionView不含原始story、flags、trigger或effects。scenes只含已发现和从当前场景实际可达的节点，links再过滤到可见集合。交互只返回当前探索场景且满足前置条件者的id/label/description；背包只包含已有物品；objectives是作者明确公开的目标文本；ending只在达成后投影。PublicContext只含公开事件，DirectorContext增加公开affordances、inventory/status；个人事件、秘密、令牌、QQ ID不进入模型输入。作者必须把秘密写在条件/效果/私密文本里，公开label/description/objective不能被当作秘密字段。

创建可指定ruleVersion/scenarioVersion，省略按数值语义版本取最高。catalog保留两个lantern-vault版本。会话引用包快照，导入新包不改变已有会话；同id/version不可覆盖。导入只接受受限JSON，最大1MiB。旧save-v1封套继续兼容，新增story在旧档缺失时归一化；新档的旗标/背包/路径/去重/结局/pending均校验引用。

## 可替换模块

RuleEngine registry仍支持注册执行器；默认仅允许simple-d20-v1包。KPProvider可注入 models Map；v0.2支持interpret(DirectorContext)和narrate(PublicContext)。旧自定义narrate-only provider保留聊天兼容，不自动执行动作。HttpKP可注入Transport(url,init)用于无付费集成测试，默认fetch并受超时保护，上游错误原文不透传。Store有MemoryStore/FileStore，同会话与索引写入排队，文件rename原子替换；文件写入失败/多进程故障恢复并非数据库事务。

`rules.ts` 中旧IntentInterpreter/ActionProposal registry保留为扩展兼容接缝，不是默认主持入口。新的默认主持入口是KPProvider.interpret和GameService.mutate。DocumentImporter/Retriever/AssetProvider/ChannelAdapter/ToolRegistry仍可注册，原有纯文本、关键词、位置文字和QQ标准化模拟能力保留。

模型协议依据：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)、[Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)。OpenAI用Responses text.format，Claude用output_config.format，Gemini用Interactions response_format(text/application-json)与steps/model_output。真实API及QQ未联调；注入transport测试不代表真实账号成功。

公开模型输入显式附带canonical opening、当前scene说明/NPC和公开objectives完成情况，均从包公开字段和状态生成，不依赖旧KP文本。opening/场景说明各限1800字，NPC最多10条各600字，目标最多20条各200字；上游完整JSON输入限120000字符，超限在网络请求前拒绝。动作能力匹配按结构语义比较，忽略JSON键顺序且拒绝额外字段。
