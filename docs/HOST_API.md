# 新自由主持接口 0.3-half

本机管理接口统一 `/api/host`，需要 `X-Admin-Token`。例外：OneBot callback用独立QQ secret验签。仅接受本机Host与同源请求；JSON请求体1MiB上限。错误 `{error:{code,message}}`，不会包含上游响应体或凭证。所有新增状态独立存储于 `<AIKP_DATA_DIR>/free-host/host-state.json`，不迁移旧版。

## 配置

- `GET /config` → `{providers:[{id,model,baseUrl?,timeoutMs?,maxOutput?,configured,status}],qq:{enabled,apiBaseUrl,accessTokenConfigured,secretConfigured,callbackPath}}`。demo为`fixed-protocol-demo`。
- `POST /config` `{provider:'openai'|'anthropic'|'gemini',model?,apiKey?,baseUrl?,timeoutMs?,maxOutput?,deleteApiKey?}`。key空白保留；deleteApiKey:true删除保存值。保存值覆盖.env；删除后仍可能使用env。model、baseUrl可自定义，baseUrl为版本根目录（如/v1或/v1beta），不带终端路径、凭证或query。
- `POST /config` `{qq:{enabled?,apiBaseUrl?,accessToken?,secret?,deleteAccessToken?,deleteSecret?}}`。独立凭证，空白保留。QQ接收启用时必须有secret。
- `POST /test` `{provider,confirmBillable:true}` → `{ok,provider,model,message}`。真实计费连接请求；仅允许finish_turn，不修改团。没确认或没有key明确失败，不回落演示。

`.env`支持三家`*_API_KEY/MODEL/BASE_URL/TIMEOUT_MS/MAX_OUTPUT`，与旧版共用；新流程默认超时60000ms、maxOutput4000。POST timeoutMs允许100..180000，maxOutput允许100..64000，具体模型也可能拒绝不兼容值。

## 原文资料与团

- `GET /materials` → `{materials:[{id,kind,title,createdAt,characters}]}`（不返回全文）。
- `POST /materials` `{kind:'rules'|'scenario',title,text}` → `{material}`。text是完整UTF-8文本，1..200000字符；title最多200字符。成功保存原文，超限拒绝。文件解码由网页完成；此接口不解析PDF或扫描图。
- `POST /rooms` `{name,provider,rulesId?,scenarioId?,players:[{id,name,description?}]}` → `{room}`，201。至少1名、至多30名玩家，id不重复。省略素材使用内置原创规则/《雾港停钟》，`usingBuiltin:true`并生成notice。demo也有显著notice。
- `GET /rooms` → `{rooms:[{id,name,provider,usingBuiltin,updatedAt}]}`。
- `GET /rooms/:id` → `{room}`，仅管理投影，含秘密，请勿公开共享。
- `POST /rooms/:id/messages` `{messageId,playerId,text,kind:'dialogue'|'action'|'ooc'|'auto'}` → `{room,duplicate?}`。网页使用前三种，QQ使用auto由模型判断。text 1..6000字符。messageId 1..200字符，必须由调用方为新一轮唯一生成。同ID包括失败永久去重，不重新骰。
- `POST /rooms/:id/start` `{messageId}` → `{room,duplicate?}`，请求模型开场。
- 主持失败返回200并在`room.receipts[messageId]`记`status:'failed',error,code`，`events`追加公开error，保留已完成骰与记忆。接口输入错误、鉴权错误仍4xx。

`room`字段：

```json
{
  "id": "uuid",
  "name": "团名",
  "provider": "demo",
  "players": [{ "id": "a", "name": "玩家", "description": "" }],
  "rulesId": "",
  "scenarioId": "",
  "usingBuiltin": true,
  "events": [
    {
      "id": "uuid",
      "type": "notice|player|kp|error",
      "text": "公开文本",
      "messageId": "...",
      "at": "ISO",
      "playerId": "a",
      "kind": "action"
    }
  ],
  "rolls": [
    {
      "id": "uuid",
      "messageId": "...",
      "expression": "2d6+3",
      "values": [2, 5],
      "bonus": 3,
      "total": 10,
      "reason": "公开骰原因",
      "at": "ISO"
    }
  ],
  "memory": {
    "facts": [],
    "mainQuest": "",
    "sideQuests": [],
    "npcs": [],
    "pace": ""
  },
  "gmNotes": [],
  "receipts": {
    "...": {
      "status": "processing|complete|failed",
      "at": "ISO",
      "error": "...",
      "code": "..."
    }
  },
  "deliveries": {},
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

处理中的receipt短暂包含私密工具检查点，完成/失败后删除。每个receipt不存完整历史。保存采用串行临时文件→rename，单进程使用。重启把processing标failed，保留骰，不重新请求。网络断开可用原ID查重获取当前room。公开投影只包括events、rolls、memory，私密gmNotes、完整原文、原始工具不发送给QQ。玩家发言自身属于公开输入。

## 主持工具与协议

- `roll_dice({expression,reason})`，支持`NdM±K`，N1..30、M2..100000；服务端crypto.randomInt。reason须可公开。
- `remember_campaign({facts:string[],gmNotes:string[]})`，追加公开事实/私密记忆。每组最多80条，每条最多6000字，各累计1000条上限，超限明确失败。
- `update_progress({mainQuest,sideQuests:string[],npcs:string[],pace})`，整体替换公开进度；NPC秘密写gmNotes。
- `query_materials({kind:'rules'|'scenario',offset:integer,keyword:string})`，原文12000字符分块检索。返回`{found,text?,offset?,nextOffset?,totalCharacters}`。关键词空串按偏移读取。提示词初始给每份前12000字并告知原文长度与继续工具，不丢弃后续文本。
- `finish_turn({publicReply})`，唯一公开剧情提交，1..16000字符，必须最后一个工具。原生模型文本、思考、其他工具结果不直接发布。

每轮最多8次模型请求、一次最多12工具。三家原生协议分别Responses function_call/function_call_output（保留output）、Messages tool_use/tool_result（保留thinking/signature完整assistant content）、Interactions user_input→完整steps→独立function_result（store:false，不使用previous_interaction_id）。拒答/截断/未完成错误不公开原文。提示词要求不替玩家选择、不随意改写真相、推进主线兼顾支线与节奏，但自然语言保密及质量仍须真实模型验证。

## OneBot

- `POST /rooms/:id/qq` `{groupId,mode:'mention'|'all'}` → `{room}`。groupId为正的安全整数数字字符串，同群只绑定一桌。
- `POST /qq/simulate` `{roomId,userId,nickname,text,messageId}` → `{room,reply,simulated:true}`，离线模拟，不发群，内部ID加`qq-sim:`前缀。
- `POST /qq/events` 标准OneBot v11 group message事件。无需admin；必须`X-Signature: sha1=<hex>`，用独立QQ secret对**原始body字节**HMAC-SHA1。未启用403，签名错误401。接收持久化inbox后`{ok:true,queued:true}`立即返回，后台串行主持。重复返回`duplicate:true`。忽略返回`ignored:true`。
- QQ原始发言用kind:auto（由模型分辨对话/行动/OOC），支持message数组与CQ文本提及。忽略自己、非绑定群、不满足mention模式的消息。自动加入QQ用户角色。
- 发信请求`POST <apiBaseUrl>/send_group_msg`，`{group_id:number,message:string,auto_escape:true}`，有token时`Authorization: Bearer <accessToken>`。只包含本条公开回复/错误和骰点。
- `room.deliveries['qq:<group>:<message_id>']`状态：sending、bridge-ok（HTTP成功且status:ok/retcode:0）、accepted-async（status:async/retcode:1，仅已提交）、failed（错误/结果未知）、unknown-after-restart（sending时重启）。不自动重发，不重跑主持。
- 真实QQ账号与桥接器由用户提供。本轮仅测试假桥接器，未安装、登录或发真实群。

## 官方协议依据

核对日期2026-10-24，测试以原生schema夹具验证，非真实账号兼容证明。

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Anthropic tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) / [tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview) / [stateless function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [OneBot HTTP POST](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md) / [public API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)
