# Zotero Topic Explorer

独立 Zotero 9.0.6 选题探索插件，TypeScript；不绑定学科。稳定契约见 README.md 与 docs/。

- 仅操作本项目。旧 Zotero MCP Plus / AI Butler、主 profile、真实文库与客户端凭据不修改。
- 不调用外部 Codex/Gemini 等助手，除非用户当前明确请求；父目录旧协作模板不是对外发送授权。
- 插件内的模型请求只在用户确认材料、接收方与预算后执行。开发验证顺序：`npm run test:unit` → `npm run typecheck:test` → `npm run lint:check` → `npm run build` → `npm run test:integration`（隔离 profile，会显示 Zotero 窗口，用户已允许）。
- 真实模型联调只用 `test/integration/live.test.ts` 的合成材料，通过 `TOPIC_EXPLORER_LIVE_*` 环境变量注入；密钥只放会话内存，不写入仓库、日志或记忆。
- 不读取第三方插件 API key、不硬编码密钥、不写主库、不自动安装到主 profile。
- 远程仓库 `asuka123456789/zotero-topic-explorer`；提交与推送按用户当前要求执行，`.scaffold/` 与任何密钥文件不得入库。
- 一个文件同一时刻仅一个执行者修改，公共类型变更先协调。
- 报告区分 mock、原生集成、真实模型验证，未运行不能宣称通过。
