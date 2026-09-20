# 验证记录（2026-09-20）

环境：Windows 11，Node v24.12.0，npm 11.6.2，TypeScript 5.9.3，zotero-plugin-scaffold 0.9.2，zotero-plugin-toolkit 5.1.2。目标 Zotero 9.0.6。

## 已运行并通过

| 检查                           | 命令                                      | 结果                                                                      |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------- |
| 单元测试                       | `npm run test:unit`                       | 80 passing，0 failing（Mocha 12，Node 原生 strip-types，无网络）          |
| 类型检查（源码）               | `npm run typecheck`                       | 通过                                                                      |
| 类型检查（含测试）             | `npm run typecheck:test`                  | 通过                                                                      |
| Lint                           | `npm run lint:check`                      | prettier 与 eslint（@zotero-plugin/eslint-config 0.6.10）均通过           |
| 打包                           | `NODE_ENV=production zotero-plugin build` | 生成 `.scaffold/build/zotero-topic-explorer.xpi`（约 78 KB，15 个文件）   |
| manifest / prefs / locale 核对 | 读取 `.scaffold/build/addon/*`            | ID、版本、`.invalid` update_url、`9.0.6`–`9.0.*`、偏好前缀与 FTL 前缀正确 |

单元测试覆盖的内容：

- 领域：SHA-256 与 UTF-8 字节数、快照指纹与键顺序无关、候选题/评审/卡片结构校验、未知证据 ID 与伪造引文拒绝、未知字段（含假页码）拒绝、评审必须覆盖冻结候选题、证据 hash 与字符范围校验。
- Markdown 导出：来源声明、HTML/Markdown 转义、页码定位、项目导出只含所属卡片、不完整草稿标记。
- 编排：未确认零请求、指纹不匹配拒绝、完整 6 次请求并生成卡片、坏 JSON 不重试且计入额度、取消中止在途请求、预算耗尽失败、重启恢复 `interrupted/result_unknown` 且不释放额度、未确认未知状态不能重试、重试只重做受影响阶段、用户编辑与备注不被覆盖。
- 提示词与预算：证据脱敏（不含 itemKey/attachmentKey/annotationKey/hash/extraction）、系统提示不含文献原文、不可信数据边界标记、预算范围校验、输入字节上限。
- 存储：SQLite（mock 连接）与内存实现的 `user_version` 拒绝降级、`quick_check` 失败停止写入、乐观锁版本冲突、关闭后拒绝操作、深拷贝隔离。
- Zotero 只读：普通条目、附件归父去重、独立 PDF、非 PDF 独立附件拒绝、回收站拒绝、超过 20 篇拒绝、跨库拒绝、分类默认仅直接成员；证据采集的题录白名单、缺摘要写 warnings、批注 pageLabel 原样保留、全文缓存只读且不触发索引、无页码只给字符范围、来源跳转只按本地 key。
- 凭据：Login Manager 专属 origin/realm、重复保存覆盖、删除、仅会话内存、不可用时不降级为明文、持久化失败不残留、不读其他 realm/origin。
- 传输层：https/loopback 规则、userinfo/query/hash 拒绝、端点规范化、请求体字段、`redirect: "error"`、`credentials: "omit"`、HTTP 状态映射、网络异常/超时/取消映射、错误消息不含密钥与响应正文、响应超限拒绝、发送前参数校验、密钥缺失不发请求。

## 未运行

| 项目                            | 原因                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zotero 9.0.6 隔离集成测试       | `scripts/test-isolated.mjs` 会启动一个显示窗口的 Zotero 实例（scaffold 在 Windows 上没有无头模式）；需要先确认允许，并通过 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 指定可执行文件、设置 `TOPIC_EXPLORER_ALLOW_GUI=1` |
| 真实模型联调                    | 未配置任何真实 API key；所有模型行为只用本地假传输验证                                                                                                                                                       |
| 主 profile 安装                 | 未安装到任何 Zotero profile                                                                                                                                                                                  |
| Login Manager / FilePicker 实测 | `addLoginAsync`、`Zotero.DBConnection`、`openDialog` 非模态窗口等运行时行为只经类型检查和假对象测试，尚未在 Zotero 9.0.6 中实际执行                                                                          |

因此当前状态是：源码、单测、类型、lint、打包全部通过；插件在真实 Zotero 中的加载、菜单、工作台、数据库与凭据行为**尚未验证**，不能宣称可用。

## 集成测试内容（待运行）

`test/integration/plugin.test.ts` 共 6 项：插件初始化与 3 个菜单注册；独立 SQLite 初始化与项目保存；从真实条目只读采集书目/摘要且不修改条目；6 次讨论只走本地假传输并生成 2 张卡片；凭据只存插件 realm 且不落偏好；工作台窗口可打开并关闭。运行后结果写入 `.scaffold/test/data/topic-explorer-result.json`。
