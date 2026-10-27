# HTTP API v0.2

JSON 请求/响应；错误统一 `{error:{code,message}}`，非2xx。只接受同源，无开放CORS。管理接口 `X-Admin-Token`；会话接口 `Authorization: Bearer <token>`。令牌只在创建/加入/恢复时返回。成功行动返回 `{session:SessionView}`。

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| GET /api/health | 无 | `{status:"ok",version:"0.2.0"}` |
| GET /api/catalog | 无 | `{rules:[{id,version,name,description,supported,unsupported}],scenarios:[{id,version,name,description}],providers:[{id,name,ready,status}],extensions:[...]}` |
| GET /api/config | 管理 | 三家配置状态、模型名、配置变量名、protocol/timeoutMs/maxOutput；不含key |
| POST /api/sessions | 管理；`{name,ruleId?,ruleVersion?,scenarioId?,scenarioVersion?,provider?}` | 201 `{ownerToken,inviteCode,session}` |
| POST /api/sessions/:id/join | `{inviteCode,name}` | 201 `{playerToken,actorId,session}` |
| GET /api/sessions/:id | 会话 | `{session}` |
| GET /api/sessions/:id/events | 会话 | `{events,version}`，已过滤身份 |
| POST /api/sessions/:id/actions | 玩家；`{requestId,expectedVersion,kind,payload}` | `{session}` |
| POST /api/sessions/:id/control | 房主；`{requestId,expectedVersion,command}` | `{session}` |
| GET /api/sessions/:id/export | 房主 | `{save}`，完整主持秘密，敏感文件 |
| POST /api/sessions/restore | 管理；`{save}` | 201 `{ownerToken,inviteCode,session,recoveredPlayers:[{actorId,playerToken}]}` |
| POST /api/packages/validate | 管理；JSON包本体 | `{valid:true,package:{id,version,kind,name}}` |
| POST /api/packages/import | 管理；JSON包本体 | 201 `{package:{id,version,kind,name}}` |
| POST /api/qq/bind | 房主；`{sessionId,qqUserId,playerToken}` | `{bound:true}` |
| POST /api/qq/simulate | 管理；`{sessionId,qqUserId,eventId,text,expectedVersion}` | `{session,channel:"qq-simulated"}` |

默认 ruleId=simple-d20，scenarioId=lantern-vault，provider=mock。指定版本精确匹配；省略取数值semver最高（当前剧本2.0.0）。同id/version包不可覆盖。旧存档保存原包快照，不自动升级。

## 行动与主持

| kind | payload | 行为 |
| --- | --- | --- |
| say | `{text}`，1–2000字 | 自然语言解释、规则、剧情触发、已批准事实叙述；正常对话/澄清不消耗资源 |
| interact | `{targetId}` | 仅当前公开interaction；DC/成本来自剧本 |
| check | `{skill?,dc?}` | 自由检定，DC5–25，消耗1体力，无剧情效果 |
| move | `{sceneId}` | 探索且当前路径实际已解锁 |
| attack | `{targetId}` | 战斗、本人回合、有效存活敌人、消耗1体力 |
| end_turn | `{}` | 敌人反击、下一存活玩家、恢复下一玩家2体力 |
| rest | `{}` | 仅探索，恢复本人到规则上限 |
| retreat | `{}` | 剧本配置撤退结局，结束本次冒险 |
| confirm | `{proposalId}` | 提案ID+actor+当前版本匹配才执行 |
| cancel | `{proposalId}` | 同样校验后取消 |

不接受actorId、任意flags/items/DC覆盖或其他payload字段。身份只来自token。规则/剧情/叙述失败均回滚克隆状态，不部分提交。无效模型动作拒绝，不静默执行另一动作。暂停禁止玩家行动；结束后只允许say回顾、查看、导出，拒绝行动/加入/control变更。

control.command=pause/resume/start_combat；start_combat保留v0.1手动演示能力。房主须另加入玩家身份才能行动。

requestId为1–100字符。版本从0开始；加入、成功行动/对话/澄清/提案/取消/control写入均+1；QQ绑定不改变游戏版本。相同身份+requestId完全相同内容重试返回原结果；不同内容复用返回409 IDEMPOTENCY_CONFLICT。提案绑定产生后的版本，任何其他成功游戏写入使其失效；新requestId不能重放已消费提案。完全相同requestId的网络重试仍按幂等返回旧响应。恢复为新会话会取消pending并轮换令牌。

## SessionView

沿用字段：`id,name,version,provider,paused,mode,location,sceneId,scenes,actors,enemies,turnActorId,events,personal,role,actorId,rule,scenario`。mode=exploration/combat；role=owner/player；owner的actorId=null。Actor=`{id,name,hp,maxHp,ac,bonus,stamina}`；Event=`{id,version,type,text,audience}`。scenes=`[{id,name,description,links,npcs:[{name,description}]}]`，仅已发现或当前可达节点，links过滤锁定目标。

新增字段：

```ts
status: 'active' | 'won' | 'lost';
inventory: {id:string; name:string; quantity:number}[];
objectives: {id:string; text:string; completed:boolean}[];
interactions: {id:string; label:string; description:string}[];
ending: null | {id:string; title:string; text:string};
pending: null | {
  id:string; actorId:string; version:number; message:string;
  action:{kind:'check'|'attack'|'end_turn'|'move'|'interact'|'rest'|'retreat';payload:object};
};
director: 'local-demo' | 'provider';
```

pending仅本人可见；房主和其他玩家看null。个人事件只对本人投影；公共模型输入不含个人事件或personal。新公开事件type包括decision、dialogue、clarification、proposal、confirm、cancel、interact、inventory、objective、reveal、rest、ending。UI应使用类型与权威字段区分执行和建议；KP文本不是权威状态。

模型Decision为`{type:'dialogue'|'action'|'clarification'|'proposal',message:string,action:null|{kind,payload}}`。该对象由服务器消费，不向客户端提供隐藏条件。action仅可引用当时公开affordances，且再次校验身份、回合、资源与剧情条件。真实供应商interpret与narrate各使用结构化JSON协议；未配置时报503且不付费回退。

错误码保留AUTH_REQUIRED/ADMIN_REQUIRED/OWNER_REQUIRED/PLAYER_REQUIRED/FORBIDDEN/NOT_FOUND/INVALID_INPUT/INVALID_PACKAGE/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/PAUSED/WRONG_TURN/INSUFFICIENT_RESOURCE/PROVIDER_UNAVAILABLE/PROVIDER_FAILURE；新增INVALID_TARGET/INVALID_DECISION/INVALID_PROPOSAL/TRIGGER_LIMIT/TRIGGER_FAILURE/ENDED，存档错误INVALID_SAVE。冲突后先GET刷新版本。

QQ模拟复用say同一导演入口，eventId映射requestId并去重；真实QQ尚未接入。包和存档只接受JSON对象，不接受本机路径；包最大1MiB。完整导出包含剧本秘密，勿作为网页公共内容。
