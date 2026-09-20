# Zotero Topic Explorer / 选题探索

面向 Zotero 9.0.6 的选题探索插件：从你选定的文献和自己的条件出发，让“探索、文献审查、可行性评估、主控汇总”四个角色按固定流程讨论，保留分歧，生成可编辑、可追溯的选题卡片。不绑定任何学科，也不绑定任何模型品牌。

当前版本 `0.1.0`。只在 Zotero 9.0.6 上开发和验证；未在其他版本测试，`manifest.json` 也只声明 `9.0.*`。

## 它做什么

1. 在 Zotero 主窗口右键文献或分类，选择“探索选题”；或从“工具”菜单打开工作台。
2. 插件只读取书目信息和摘要（题名、作者、日期、DOI、摘要）。你可以显式加入已有批注、Zotero 已经生成的 PDF 全文缓存片段，或手动摘录原文。
3. 在工作台填写研究兴趣、已有基础、时间、算力和数据条件；缺失的写“未知”，讨论不会替你假设。
4. 点击“生成发送预览”后，插件列出将发送的材料数量与大小、每个角色使用的服务地址和模型、最大请求数与输出上限。此时不联网。
5. 只有点击“确认发送并讨论”后才会请求模型。流程固定为 6 次请求：

| 步骤 | 角色       | 说明                                  |
| ---- | ---------- | ------------------------------------- |
| 1    | 探索       | 从材料和约束中提出 2–3 个候选问题     |
| 2    | 文献审查   | 独立初审（与第 3 步并行，彼此不可见） |
| 3    | 可行性评估 | 独立初审（与第 2 步并行，彼此不可见） |
| 4    | 文献审查   | 针对可行性意见提出质疑                |
| 5    | 可行性评估 | 针对文献意见提出质疑                  |
| 6    | 主控汇总   | 汇总成选题卡片，保留未解决分歧        |

6. 生成的卡片包含研究问题、动机、支持/反对证据、与已有工作的区别、资源要求、最小验证实验、停止条件、未解决分歧和下一步。你可以编辑卡片、设置“继续探索／准备试验／暂缓／放弃”、写备注；AI 重新分析不会覆盖你的编辑和备注。
7. 单张卡片或整个项目可导出为 Markdown。

## 它不做什么

- 不联网搜索新论文，不做全网查新；每张卡片固定声明“仅基于所选资料，未完成全网查新”。
- 不自动提取 PDF、不 OCR、不下载附件、不建立全文索引。
- 不自动写入 Zotero：不创建或修改文献、笔记、标签、附件。
- 不自动训练模型、跑实验或写整篇开题报告。
- 不自动测试密钥、不后台运行、不自动重试。
- 不读取其他插件或 Claude Code 等程序的 API key。

## 模型与费用

- 首版只支持 **OpenAI-compatible Chat Completions 非流式接口**：手动填写 `baseURL`、模型名、API key，并选择输出上限字段（`max_tokens` 或 `max_completion_tokens`）。没有在所有“兼容接口”上验证，见 [docs/privacy-and-compatibility.md](docs/privacy-and-compatibility.md)。
- 四个角色可以绑定不同配置，也可以全部共用一个；共用时预览会明确标注它们不是彼此独立的专家。
- 每次实际发送都占用请求额度，错误响应也算。默认每轮最多 6 次请求、每次输出 3000 tokens、单次输入 96 KB、总时限 10 分钟。
- 用量按服务端返回的 `usage` 记录；服务端不返回时标为“未知”。插件没有价格信息，不能承诺金额上限。
- 停止讨论后不再发送新请求，会尽力中止在途请求；已提交的请求仍可能计费。
- Zotero 重启后，处于“请求中”的阶段会标为“结果未知”，不会自动重发；手动重试前需要勾选确认可能重复计费。

## 数据与隐私

- 项目、材料快照、讨论记录、卡片保存在 Zotero 数据目录下的 `zotero-topic-explorer.sqlite`，独立于 Zotero 主数据库。
- API key 保存在 Zotero（Firefox）Login Manager，以本插件专属的 origin/realm 隔离；也可选择“仅本次会话”不持久化。密钥不会写入偏好文件、日志或导出文件。
- 发给模型的内容只有：证据编号、标题、文本、真实存在的页码标签（批注）、你填写的研究约束。不会发送 Zotero 内部 key、文件路径或内容哈希。
- 论文、批注、摘录和模型输出都按不可信数据处理：不作为系统指令，界面只用纯文本渲染，不执行其中的代码或链接。模型引用的证据编号和逐字引文都会在本地校验；对不上的输出会让该阶段失败，不会自动追加“修复格式”请求。

## 安装（手动）

1. 构建：`npm install`，然后 `npm run build`。产物在 `.scaffold/build/zotero-topic-explorer.xpi`。
2. 在 Zotero 9.0.6 中打开“工具 → 插件”，用“Install Plugin From File…”选择该 XPI。插件不会自动安装到任何 profile。
3. 安装后打开工作台的“设置”，添加模型配置、保存密钥、绑定角色。

## 开发与验证

```text
npm run test:unit       # Mocha 单元测试（Node 24，原生 strip-types，不联网）
npm run typecheck       # tsc --noEmit
npm run build           # scaffold 打包 + 类型检查
npm run lint:check      # prettier + eslint
npm run test:integration
```

`test:integration` 会用 `scripts/test-isolated.mjs` 启动一个只使用 `.scaffold/test` 隔离 profile/data 的 Zotero 实例，需要 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 指向 Zotero 可执行文件，并显式设置 `TOPIC_EXPLORER_ALLOW_GUI=1`（scaffold 在 Windows 上会显示窗口）。集成测试里的“模型”是本地假传输，不产生任何网络请求。

真实模型联调是可选的：设置 `TOPIC_EXPLORER_LIVE_CONFIG`（长度为 4 的 JSON 数组，按探索、文献审查、可行性、主控顺序给出 `{ "model", "baseURL", "apiKey" }`，不同角色可指向不同服务），或用简化变量 `TOPIC_EXPLORER_LIVE_BASE_URL`、`TOPIC_EXPLORER_LIVE_API_KEY`、`TOPIC_EXPLORER_LIVE_MODELS`（4 个模型名，逗号分隔，共用同一服务）后，`test/integration/live.test.ts` 会用三条合成材料跑一轮完整讨论；密钥只在会话内存中，结果写到 `.scaffold/test/data/topic-explorer-live-result.json`。验证记录见 [docs/test-record.md](docs/test-record.md)。

## 许可与归属

MIT，见 [LICENSE](LICENSE)。插件骨架、生命周期、独立 SQLite 与隔离测试包装器改编自 Zotero MCP Plus / Zotero 插件模板，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
