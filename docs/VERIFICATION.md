# 后端验证记录

状态：**PASS（本轮本地框架范围）**。2026-10-24，Windows / Node v22.13.1 / npm 10.9.2。真实供应商与真实 QQ 均未进行外部联调，不属于运行成功声明。网页视觉及浏览器交互由中枢另行验收。

| 命令 | 结果 |
|---|---|
| `npm install` | 成功；本项目本地依赖，npm audit 0 vulnerabilities |
| `npm run typecheck` | PASS，TypeScript strict，无错误 |
| `npm run build` | PASS，生成 dist/src 与 dist/tests |
| `npm test` | PASS，23 tests / 23 pass / 0 fail / 0 skip |
| `node scripts/generate-schemas.mjs` | 生成3份 JSON Schema；examples 中2份原创包均为运行时相同源数据 |

23项包含：秘密隔离（catalog/房主默认投影/玩家个人事件/模型公共输入）、token越权与actor伪造、幂等重复与冲突、同版本并发竞争、资源耗尽与暂停无提交、战斗模式/回合/合法目标/伤害/结束、场景图限制与自由检定不揭密、缺id/错误类型/悬空link/未知规则引擎/非法参数包、不可覆盖版本与会话包快照、秘密存档去凭证与恢复轮换/引用验证/拒绝路径、FileStore重启与原token恢复、QQ未绑定拒绝与重复事件不重复提交、真实HTTP鉴权/跨域/JSON导入/恢复、三家真实REST形状与各自请求协议，以及三家 HTTP 错误/拒绝/截断/非JSON结构/超时的安全错误。

补充测试还检查并发8次建房+8次包导入后重启索引完整；模型失败不提交版本/事件；三家自定义版本根BASE_URL、输出上限、超时与拒绝URL内嵌凭证。测试 transport 全部在内存返回受控Response，没有真实供应商请求，不消耗API额度。HTTP测试只监听127.0.0.1随机端口并关闭；文件测试只用临时目录并清理。

未验证/能力边界：真实模型账号与模型权限、额度、生成质量、长团上下文表现；QQ应用权限、回调验签、access_token和公网网络；完整D&D、法术/升级、复杂地图与场景触发器；自然语言ActionProposal导演（只有接口和空注册表）；PDF/OCR与向量库；多Node进程共享data目录；公网/多设备部署。本地无key可运行Mock流程。BASE_URL配置表示协议适配接口存在，不证明任意第三方中转兼容。

启动：`npm start` 自动载入本项目存在的 `.env`。`PORT` 默认3000，`AIKP_DATA_DIR` 默认data，`AIKP_ADMIN_TOKEN` 可选；否则首启生成被忽略的 `data/admin-token.txt`。一键入口 `start.cmd`/`start.ps1`。不在本文件记录任何真实令牌。
