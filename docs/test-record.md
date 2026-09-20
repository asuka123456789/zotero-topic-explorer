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

## 真实模型联调

入口：`test/integration/live.test.ts`，由 `TOPIC_EXPLORER_LIVE_CONFIG`（逐角色 model/baseURL/apiKey）或简化变量启用；三条**合成**材料（虚构文献 A/B/C），密钥只放会话内存。

### 第 3 轮（2026-09-20，最终路由，通过）

按用户指定的模型与入口，四个角色分别走三个服务：

| 角色       | 模型                         | 服务                                                    |
| ---------- | ---------------------------- | ------------------------------------------------------- |
| 探索       | `grok-4.20-multi-agent-0309` | `https://grok.myasuka.me/v1`（grok2api 直连）           |
| 文献审查   | `gemini-3.8-flash-high`      | `https://cpa.myasuka.me/v1`（CLI Proxy API）            |
| 可行性评估 | `deepseek-v4.1-flash`        | `https://codebuddy.myasuka.me/v1`（codebuddy2api 直连） |
| 主控       | `gpt-5.6-sol`                | `https://cpa.myasuka.me/v1`                             |

结果：6/6 请求完成，生成 2 张卡片（探索步只提出了 2 个候选题）；每张卡片含引用 E1/E2/E3 的 fact 论断、inference/proposal 论断、可衡量的最小实验与停止条件，并保留了文献审查与可行性评估的分歧。

| 步骤                  | 模型                       | 输入 tokens | 输出 tokens | 用时    |
| --------------------- | -------------------------- | ----------- | ----------- | ------- |
| explore               | grok-4.20-multi-agent-0309 | 60,844\*    | 13,247      | 50.8 s  |
| literature            | gemini-3.8-flash-high      | 1,385       | 2,689       | 8.9 s   |
| feasibility           | deepseek-v4.1-flash        | 1,362       | 1,310       | 8.1 s   |
| literature_challenge  | gemini-3.8-flash-high      | 2,877       | 3,113       | 11.3 s  |
| feasibility_challenge | deepseek-v4.1-flash        | 2,753       | 1,555       | 8.7 s   |
| synthesize            | gpt-5.6-sol                | 6,016       | 5,501       | 101.8 s |
| 合计                  |                            | 75,237      | 27,415      | 189.5 s |

\* 客户端实际发送约 3.5 KB；grok2api 对 multi-agent 模型把服务端内部子代理调用一并计入 `prompt_tokens`，插件按服务端 `usage` 如实记录，不做估算。

路由说明：

- CPA 上的 grok 模型走的是 CPA 自己的 xAI OAuth 账号（日志 `auth=xai-*.json`），不是 grok2api；那些账号额度用尽时 `grok-4.20-*`、`grok-4.3` 返回 402。直连 grok2api 后全部 200。为此新增 HTTPS 入口 `grok.myasuka.me`（Cloudflare DNS-only A 记录 + Caddy `reverse_proxy 127.0.0.1:3003`，Caddyfile 备份 `Caddyfile.bak-grok-domain-20260920T042834Z`），因为插件不接受非回环的明文 HTTP。
- `deepseek-v4.1-flash` 经 CPA 返回 503 `model_price_error`（cpa-key-billing 插件没有为它配置价格），所以直连 codebuddy2api。

### 第 1–2 轮（2026-09-20，早期路由）

角色绑定：探索 `claude-sonnet-4-6`，文献审查 `gemini-3.8-flash-high`，可行性评估 `grok-4.6`，主控 `claude-sonnet-4-6`，全部经 `https://cpa.myasuka.me/v1`。

| 轮次    | 结果             | 说明                                                                                                                                                                                                                                                                                        |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 轮 | 失败（3/6 请求） | 第 3 步 grok-4.6 把 `citations[].evidenceId` 写成 `id`，本地校验按“未知字段”拒绝并停止（未自动重试，额度计 3）。处理：校验器接受 `id` 作为 `evidenceId` 的同义字段（两者同时出现且不一致仍拒绝）；提示词明确字段名；同时本地剥离 ```json 围栏（`claude-sonnet-4-6` 在冒烟测试中返回过围栏） |
| 第 2 轮 | 完成（6/6 请求） | 生成 3 张卡片；合计 27,416 输入 / 28,207 输出 tokens，372.5 s                                                                                                                                                                                                                               |

其他模型冒烟结果（同日）：`claude-opus-5` 经 CPA 三次 504（上游 `api.zzzcoding.org` 连接超时）；`claude-opus-4-6-thinking` 503；`deepseek-v4.1-flash` 经 CPA 503 无价格；`grok-4.5`、`grok-composer-2.5-fast` 经 CPA 200 但由 xAI OAuth 账号服务。

## 未做

- 未安装到主 Zotero profile；未在真实文库上运行。
- 未做任何自动重试或跨提供方回退；失败轮次按设计停止并保留原始输出。
- 除上表模型与服务外，其他 OpenAI-compatible 服务未验证。
