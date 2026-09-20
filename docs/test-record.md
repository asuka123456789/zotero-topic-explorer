# 验证记录（2026-09-20）

环境：Windows 11，Node v24.12.0，npm 11.6.2，TypeScript 5.9.3，zotero-plugin-scaffold 0.9.2，zotero-plugin-toolkit 5.1.2，Zotero 9.0.6（`E:\zotreo\zotero.exe`，仅用于隔离 profile）。

## 本地检查（全部通过）

| 检查                           | 命令                                      | 结果                                                                                                                               |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试                       | `npm run test:unit`                       | 82 passing，0 failing（Mocha 12，Node 原生 strip-types，无网络）                                                                   |
| 类型检查（源码）               | `npm run typecheck`                       | 通过                                                                                                                               |
| 类型检查（含测试）             | `npm run typecheck:test`                  | 通过                                                                                                                               |
| Lint                           | `npm run lint:check`                      | prettier 与 eslint（@zotero-plugin/eslint-config 0.6.10）均通过                                                                    |
| 打包                           | `NODE_ENV=production zotero-plugin build` | `.scaffold/build/zotero-topic-explorer.xpi`，15 个文件，SHA-256 `4c15dedae6bbca18e2a3b9cc67043fdd44ea5c9e791a6becea17879a7bc36651` |
| manifest / prefs / locale 核对 | 读取 `.scaffold/build/addon/*`            | ID、版本、`.invalid` update_url、`9.0.6`–`9.0.*`、偏好前缀与 FTL 前缀正确                                                          |

单元测试覆盖：领域校验（SHA-256、快照指纹、候选/评审/卡片结构、未知证据与伪造引文拒绝、未知字段拒绝、`citations[].id` 同义字段接受但冲突拒绝、```json 围栏本地剥离）、Markdown 导出与转义、6 步编排与预算/取消/恢复/重试、提示词脱敏与不可信边界、SQLite/内存存储、Zotero 只读选择与证据采集、Login Manager 凭据隔离、OpenAI-compatible 传输层安全规则与错误映射。

## Zotero 9.0.6 隔离集成测试（通过）

命令：`ZOTERO_PLUGIN_ZOTERO_BIN_PATH=E:/zotreo/zotero.exe TOPIC_EXPLORER_ALLOW_GUI=1 npm run test:integration`，只使用 `.scaffold/test/{profile,data}`，未触碰主 profile 与真实文库。

| 轮次    | 结果 | 说明                                                                                                                                                                                                          |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 轮 | 4/6  | 两项失败：`Zotero.DBConnection.queryAsync` 返回的行是按列名取值的 Proxy，访问 `getResultByName` 直接抛错。已修 `src/storage/sqliteStore.ts` 的 `getColumnValue`：先按列名读取，再回退到 `mozIStorageRow` 接口 |
| 第 2 轮 | 6/6  | 插件初始化与 3 个菜单注册；独立 SQLite 初始化与项目保存；从真实条目只读采集书目/摘要且条目未被修改；6 步讨论走本地假传输生成 2 张卡片；凭据只存插件 realm 且不落偏好；工作台窗口可打开并关闭                  |

结果文件：`.scaffold/test/data/topic-explorer-result.json` = `{"total":6,"passed":6,"failed":0}`。

## 真实模型联调（通过 1 轮，另有 1 轮失败后修复）

入口：`test/integration/live.test.ts`，由 `TOPIC_EXPLORER_LIVE_*` 环境变量启用；三条**合成**材料（虚构文献 A/B/C），密钥只放会话内存。服务：`https://cpa.myasuka.me/v1`（CLI Proxy API，OpenAI-compatible）。

角色绑定：探索 `claude-sonnet-4-6`，文献审查 `gemini-3.8-flash-high`，可行性评估 `grok-4.6`，主控 `claude-sonnet-4-6`。

| 轮次    | 结果             | 说明                                                                                                                                                                                                                                                                                        |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 轮 | 失败（3/6 请求） | 第 3 步 grok-4.6 把 `citations[].evidenceId` 写成 `id`，本地校验按“未知字段”拒绝并停止（未自动重试，额度计 3）。处理：校验器接受 `id` 作为 `evidenceId` 的同义字段（两者同时出现且不一致仍拒绝）；提示词明确字段名；同时本地剥离 ```json 围栏（`claude-sonnet-4-6` 在冒烟测试中返回过围栏） |
| 第 2 轮 | 完成（6/6 请求） | 生成 3 张卡片，每张含引用 E1/E2/E3 的 fact 论断、inference/proposal 论断、可衡量的最小实验与停止条件，并保留文献审查与可行性评估之间的分歧                                                                                                                                                  |

第 2 轮各阶段（服务端 `usage`，墙钟时间）：

| 步骤                  | 模型                  | 输入 tokens | 输出 tokens | 用时    |
| --------------------- | --------------------- | ----------- | ----------- | ------- |
| explore               | claude-sonnet-4-6     | 1,279       | 2,488       | 35.7 s  |
| literature            | gemini-3.8-flash-high | 1,881       | 4,020       | 12.0 s  |
| feasibility           | grok-4.6              | 2,097       | 4,777       | 79.7 s  |
| literature_challenge  | gemini-3.8-flash-high | 4,770       | 4,345       | 15.5 s  |
| feasibility_challenge | grok-4.6              | 4,909       | 4,691       | 82.5 s  |
| synthesize            | claude-sonnet-4-6     | 12,480      | 7,886       | 147.0 s |
| 合计                  |                       | 27,416      | 28,207      | 372.5 s |

gemini 与 grok 的 `usage.completion_tokens` 含服务端计入的 reasoning tokens；插件只记录 `prompt_tokens/completion_tokens`。

模型可用性（冒烟测试，同一服务）：

- `claude-opus-5`：三次均 HTTP 504（30 s）；服务端日志显示上游 `api.zzzcoding.org` 连接超时，属提供方故障，不是插件问题。恢复后可直接把探索/主控换回该模型。
- `claude-opus-4-6-thinking`：HTTP 503；`grok-4.20-0309-reasoning`：HTTP 402。
- `grok-4.6`：对一个人为的“输出 {ok:true}”提示返回过一次拒绝文本；自然的中文选题提示与正式讨论均正常。
- `gemini-3.8-flash-high`、`claude-sonnet-4-6`：正常。

## 未做

- 未安装到主 Zotero profile；未在真实文库上运行。
- 未做任何自动重试或跨提供方回退；失败轮次按设计停止并保留原始输出。
- 除上表模型外，其他 OpenAI-compatible 服务未验证。
