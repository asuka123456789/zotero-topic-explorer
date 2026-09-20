# 隐私与模型兼容说明

## 会离开本机的数据

只有在你点击“确认发送并讨论”之后，插件才会向你在设置中填写的服务地址发送请求。每次请求包含：

- 本次运行快照中的证据：编号（`E1`、`E2`…）、标题、文本、批注自带的页码标签；
- 你填写的研究约束（兴趣、基础、时间、算力、数据）；
- 前序阶段经过本地校验的结构化结果（候选问题、评审意见）；
- 角色提示词。

不会发送：Zotero 内部 `itemKey`/`attachmentKey`/`annotationKey`、文件路径、内容哈希、文库其他条目、你的用户名或 Zotero 账号信息。请求不携带 Cookie，不跟随跨源重定向。

预览页会列出每个角色对应的服务地址和模型。第 2–6 步会把前序结果传给对应服务；如果四个角色绑定了不同提供方，中间评审内容会在这些提供方之间传递。

## 本地保存的数据

| 内容                             | 位置                                                                                                  | 说明                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 项目、材料快照、讨论记录、卡片   | Zotero 数据目录 `zotero-topic-explorer.sqlite`                                                        | 独立数据库，`user_version=1`，WAL + `synchronous=FULL`；损坏或版本超前时停止写入、保留现场，不自动删除重建 |
| 模型配置（地址、模型名、字段名） | 偏好 `extensions.zotero.zotero-topic-explorer.providers`                                              | 不含密钥                                                                                                   |
| API key                          | Zotero Login Manager，origin `chrome://zotero-topic-explorer`，realm `zotero-topic-explorer:<配置ID>` | 或仅本次会话内存                                                                                           |
| 模型原始输出与 usage             | 数据库 `runs` 表中的 attempt 记录                                                                     | 用于重启后本地重验，不含请求头或密钥                                                                       |

日志只记录错误类别；只有打开 `debug.verbose` 偏好后才会附带异常文本。

## 模型接口兼容性

首版只实现一种协议：`POST {baseURL}/chat/completions`，请求体为 `{ model, messages, stream: false, max_tokens | max_completion_tokens }`，读取 `choices[0].message.content` 与 `usage.prompt_tokens / completion_tokens`。

已用本地假请求层验证的行为：

- 仅接受 `https://`；`http://` 只在勾选“允许本机”且主机为 `127.0.0.1`、`localhost`、`[::1]` 时接受；
- 拒绝带用户名/密码、查询串或片段的地址；
- 3xx 一律拒绝（`redirect: "error"`），不跟随重定向；
- 401/403、404、429、其他 4xx/5xx、非 JSON、缺 `choices`、`finish_reason` 为 `length`/`content_filter`/`tool_calls` 都作为失败返回，不重试；
- 响应正文超过 4 MB 视为异常；
- `usage` 缺失时记录为“未知”。

未验证的部分：

- 没有对任何真实提供方做过联调；“OpenAI-compatible”服务在字段名、错误格式、`finish_reason` 取值上存在差异，实际使用前请先用一个便宜模型跑一轮；
- 不支持流式、工具调用、JSON Schema 强制输出、多模态输入；
- 不支持 Responses API、Anthropic Messages、Gemini 原生接口等其他协议。

## 你仍需要自己核对的事

- 引用可追溯（编号和逐字引文能在材料里找到）不等于论证成立；卡片上的“待复核”标记需要你手动清除。
- 材料只来自你选的文献；没有查新，卡片可能遗漏已有工作。
- 同一模型充当多个角色时，它们并不是独立专家，分歧可能被低估。
