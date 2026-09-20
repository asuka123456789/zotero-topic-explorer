# 第三方与复用代码归属

本项目采用 MIT 许可（见 LICENSE）。以下部分改编自其他项目，保留其归属：

## Zotero MCP Plus（MIT，Copyright (c) 2024 the Zotero-MCP project contributors）

来源 <https://github.com/asuka123456789/zotero-mcp-plus>（`zotero-mcp-plugin/` 子目录），改编内容：

- `addon/bootstrap.js`、`src/index.ts`、`src/utils/ztoolkit.ts`、`src/utils/prefs.ts`：插件沙箱与生命周期骨架（其源头为 Zotero 官方 Make It Red 示例与 zotero-plugin-template）。
- `zotero-plugin.config.ts`：手工维护 manifest、`.invalid` 更新占位、`build:makeManifest` 校验钩子。
- `src/storage/sqliteStore.ts`：`user_version` / `quick_check` / WAL / `synchronous=FULL` / 事务串行 / `closeDatabase(true)` 模式，来源于其 `taskStore.ts`。
- `scripts/test-isolated.mjs`：marker、symlink/junction 检查与本地 Chai 打包方式。

未复用：HTTP/MCP 服务器、语义索引、任务队列、预览确认协议、原生识别等功能。

## Zotero 插件生态

- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)（MIT）：运行时依赖。
- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)（MIT）：构建与测试脚手架。
- [zotero-types](https://github.com/windingwind/zotero-types)（MIT）：类型定义。
- [Make It Red](https://github.com/zotero/make-it-red) 与 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)：bootstrap 与 hooks 结构参考。

## 其他

`src/domain/hash.ts` 中的 SHA-256 为按 FIPS 180-4 规范的独立实现，用于在没有 Web Crypto 同步接口的插件沙箱中计算内容哈希。
