# HALF-CORE 核心验收记录

日期：2026-10-24。状态：**PASS（本地核心/协议夹具范围）**。版本：0.3.0-half。

## 已实现

- 新增 `src/host.ts`：独立自由主持团、完整原文资料、私密/公开记忆、主支线/NPC/节奏、串行消息与持久化去重、服务端真实骰、后台OneBot队列与发送状态。
- 新增 `src/host-providers.ts`：三家原生工具循环（最多8轮/每轮12工具），`finish_turn.publicReply`为唯一公开剧情出口。OpenAI保留output，Anthropic保留thinking/signature，Gemini stateless保留完整steps与独立function_result。
- 接入 `src/server.ts`：`/api/host`管理接口、独立验签QQ callback，默认`/`为新工作台；`/legacy`保留原页面。旧规则/固定动作引擎与原存档未迁移。
- 新资料 `examples/free-kp-rules.md`、`examples/free-kp-scenario.md`，与内置原创文本一致。
- 更新README、.env.example、package版本，新增HOST_API文档。

## 执行命令与结果

项目路径：`C:\Users\38365\CodexProjects\ai-kp`。

```text
npm run typecheck
> tsc --noEmit
exit 0

npm test
> npm run build && node --test dist/tests/*.test.js
> tsc
# tests 62
# pass 62
# fail 0
# cancelled 0
# skipped 0
exit 0
```

旧47项全部通过；新15项见 `tests/host.test.ts`：

1. OpenAI Responses工具两轮：任意未预设行动→真实骰→function_call_output→公开回复与记忆。
2. Anthropic Messages工具两轮：完整thinking签名保留→tool_result→记忆与公开出口。
3. Gemini Interactions工具两轮：user_input→完整steps→独立function_result，store:false。
4. 同桌并发排队、同messageId去重、重启后不重掷与不重跑模型。
5. API在骰后返回503，失败可读、骰持久化，重启重发不重复执行。
6. 人工中断processing检查点恢复为failed，保留骰与去重状态。
7. 原文27003字符完整保留，关键词检索尾部，200001字符明确拒绝，公开投影排除gmNotes。
8. key配置脱敏、空串保留、显式删除、环境变量继承；计费测试需明确标志。
9. 缺少真实API key明确失败，无静默演示回落。
10. 截断工具不执行、8轮循环到上限明确失败。
11. 本地假OneBot HTTP服务器：原始body签名验收、错误签名拒绝、标准群事件→主持→send_group_msg，token/auto_escape、重复/自身/mention过滤。
12. OneBot业务失败/async与发送中断恢复状态，不重复骰或发送。
13. `__proto__`等对象原型名称作为正常messageId安全去重。
14. HTTP接口原文导入→开团→开场→自由行动→读取团→超限拒绝闭环。
15. 6000字符边界输入完整保留公开事件，demo记忆只存显式摘要；6001字符明确拒绝。

三家API测试使用注入fetch的确定性协议夹具和虚假key，没有访问计费接口。OneBot测试只启动随机端口本地假桥接器，无真实QQ账号。骰点调用生产服务端`node:crypto.randomInt`，断言范围与总和，不以具体随机值作为期望。

## 隔离数据与恢复

新增自动测试使用系统临时目录；finally验证路径为mkdtemp创建的目录后清理。没有使用正式data和其他项目凭证。服务按单进程使用；临时文件→rename串行写入。每条receipt只保存轻量状态，不递归嵌入完整历史；执行中暂存工具检查点，完成/失败后删除工具参数。重启processing不会自动重试；已开始发送但结果不明标unknown-after-restart，不自动重复发信。

## 验证边界与待验收

- **没有真实API key，因此未进行真实计费调用、模型实际主持质量/自然分类/规则理解/剧本保密质量评测。** 三家协议夹具只证明本实现按核对过的schema组装和回传。
- **没有安装/登录QQ，未向真实群发信。** 本地HTTP假桥接不证明真实账号权限、桥接产品兼容或群送达。
- demo明确是固定离线协议示例，无通用行动理解或主持智能；随机骰是真实服务端生成。
- 原文完整保存，模型初始看前12000字并可分块检索。提示词约束模型保护秘密，结构上隔离gmNotes和原始工具；无法静态证明模型自然语言不会泄漏秘密或产生幻觉。
- 单机单进程JSON存储，不提供多进程一致性、完整D&D规则执行、地图战斗、扫描PDF/OCR或远程公开部署。
- 浏览器桌面/窄屏截图、视觉与可操作性验收由HALF-UI/主会话单独记录；本核心记录不宣称已完成浏览器QA。

协议来源及接口详情见 `docs/HOST_API.md`。
