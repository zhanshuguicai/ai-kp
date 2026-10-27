# v0.2 后端验证记录

任务 AIKP-CORE-02。应用版本 **0.2.0**，新增冒险包 **lantern-vault@2.0.0**。后端结果 **PASS**；原版1.0.0包与旧存档兼容仍保留。此记录说明代码/服务测试，网页浏览器证据由中枢另行记录。

## 实际执行命令

2026-10-24，在 `C:/Users/38365/CodexProjects/ai-kp` 执行：

```powershell
npm run typecheck
npm test
node scripts/play-v02.mjs
```

结果：typecheck退出0；npm test中的`npm run build`退出0；**47 tests / 47 pass / 0 fail / 0 skipped**，包含原有23项回归与新增24项。完整控制台输出保存在 `docs/verification-v02-test-output.txt`。复现脚本输出：

```json
{"peaceful":{"status":"won","ending":"light","steps":6},"combat":{"status":"won","ending":"light","steps":8},"retreat":{"status":"lost","ending":"retreat","steps":1}}
```

`examples/playthrough-v02.json` 保存本次实际执行的每一步输入、版本、状态、位置、背包与事件；不包含会话令牌、邀请码、QQ绑定或外部key。脚本使用MemoryStore和注入“每次取骰子最大值”的Dice，保证可以精确复现路线；这证明主持/规则/剧情闭环，不能代替真实随机游玩或平衡测试。脚本没有打开长期服务或发送任何网络/QQ消息。

## 从开场到结局的路线证据

和平六步全用say自然语言：

1. `调查旧箱`：铜铃+1，完成find-bell，公开“三声铃响，守卫止戈”线索。
2. `进入地窖`：位置cellar。
3. `摇响铜铃`：守卫放下武器；open-beacon触发一次，解锁cellar→beacon，完成pass-guard。
4. `进入蓝灯室`：位置beacon。
5. `修复灯芯`：剧情DC10检定成功，完成repair-wick。
6. `点亮蓝灯`：完成light-beacon，status=won，ending=light/归航之灯，所有目标完成。

战斗八步全用say自然语言：`进入地窖` → `挑战守卫` → `攻击齿轮守卫`三次 → `进入蓝灯室` → `修复灯芯` → `点亮蓝灯`。守卫18HP，实测三次各8伤害后归零，guard-victory和open-beacon各触发一次，最终won/light。正常随机骰可能需要更多次攻击和`结束回合`补充体力。

撤退：`撤退` → status=lost，ending=retreat/雾中撤退，有明确失败收束。

## 新增覆盖

- 明确动作直接结算；提问/引用/否定/条件/多动作/歧义/过去和讨论表达不误执行。真实provider依然解释NPC提问，可返回dialogue；假设问句即使被provider误判action也被拦为澄清。
- 公共投影、目录、导演/叙述上下文不含未解锁蓝灯室说明、隐藏旗标、触发器、主持真相或个人线索。个人reveal只给动作所属玩家，公共模型不读它。
- 错误身份、错误回合、跨场景/未拥有物品目标、锁定路径、强塞DC/额外参数、模型任意动作均拒绝。自由低DC检定不解锁剧情。
- 提案绑定actor/version/id，本人确认/取消、他人不可见、代确认拒绝、新requestId重放拒绝、其他写入过期。完全相同requestId网络重试依旧幂等。
- 失败检定保留重试能力，体力耗尽拒绝并回滚；休整恢复后可完成路线。叙述失败发生在发物品/触发后，整个权威状态仍不提交。
- once奖励、循环repeat每动作一次、65次触发上限整体回滚、第一结局停止后续效果/触发、存档重启/恢复去重。
- 新剧情存档引用校验；旧v1无story档包括已移动到地窖的档都保留位置/角色/事件/版本，不静默重置。
- 中文Mock经过40轮对话不递归嵌套旧KP文本。公共历史排除KP、最多16条各600字，本轮facts最多3200字，Mock单条叙述最多4000字；终局收束后提示回顾/导出。
- 三家供应商分别通过注入Transport验证interpret JSON schema、HTTP形状、动作→规则→叙述集成，以及错误、截断、拒绝、非法结构和超时；原narrate协议回归保留。
- QQ模拟复用自然语言say入口，实际获得铜铃；重复eventId不重复奖励。包导入验证坏引用、矛盾flags、重复ID和原型键。

## 验证边界

没有本项目真实模型凭证；**未调用真实OpenAI/Anthropic/Gemini付费API**，不宣称真实账号或网络联调成功。真实QQ网关/签名/发消息未接入。真实模型的自由叙述可能存在事实偏差，但不能写入权威资源/剧情状态。Mock仅覆盖注册动作与示例中文表达，遇到不理解的自然语言会澄清，不承诺任意中文剧本自动主持。

未进行公开部署、压力测试、多进程文件存储恢复、完整D&D或长局平衡测试。浏览器实际验证另见中枢保存的BROWSER_QA文档；本worker没有代替浏览器验收或启动长期进程。
公开模型上下文另显式提供canonical opening、当前scene说明/NPC、公开objectives完成情况，避免排除KP历史后丢失任务事实；不包含未来锁定场景。opening/场景描述各最多1800字，NPC最多10条各600字，目标最多20条各200字；整个上游JSON输入另限120000字符，超限在发请求前失败。真实provider集成同时验证action对象键顺序颠倒仍可执行，比较按结构语义而非序列化键顺序。
