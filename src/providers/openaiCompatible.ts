import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  ModelConfig,
  Usage,
} from "../domain/types.ts";
import { ExplorerError } from "../domain/errors.ts";

const CONFIG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 200;
/** 响应正文上限（字符）；超过即视为异常，避免无界内存占用。 */
export const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;

export interface FetchResponseLike {
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface TransportRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: "error";
  credentials: "omit";
  cache: "no-store";
  referrerPolicy: "no-referrer";
  keepalive: false;
}

export type FetchLike = (
  url: string,
  init: TransportRequestInit,
) => Promise<FetchResponseLike>;

export type KeyResolver = (configId: string) => Promise<string>;

function invalidConfig(message: string): never {
  throw new ExplorerError("INVALID_MODEL_CONFIG", message);
}

function invalidRequest(message: string): never {
  throw new ExplorerError("INVALID_REQUEST", message);
}

/** 是否包含空白或控制字符（含 DEL）。 */
function hasUnsafeChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || char.trim() === "") {
      return true;
    }
  }
  return false;
}

/** 校验模型配置；只允许 https，http 仅限 allowLocal=true 且 host 为本机回环。 */
export function validateModelConfig(config: ModelConfig): void {
  if (!config || typeof config !== "object") {
    invalidConfig("模型配置必须是对象");
  }
  if (typeof config.id !== "string" || !CONFIG_ID.test(config.id)) {
    invalidConfig("模型配置 ID 格式无效");
  }
  if (typeof config.label !== "string" || !config.label.trim()) {
    invalidConfig("模型配置缺少名称");
  }
  if (
    typeof config.model !== "string" ||
    !config.model ||
    config.model.length > MAX_MODEL_LENGTH ||
    hasUnsafeChars(config.model)
  ) {
    invalidConfig("模型名称无效");
  }
  if (
    config.outputTokenField !== "max_tokens" &&
    config.outputTokenField !== "max_completion_tokens"
  ) {
    invalidConfig("outputTokenField 必须是 max_tokens 或 max_completion_tokens");
  }
  if (typeof config.allowLocal !== "boolean") {
    invalidConfig("allowLocal 必须是布尔值");
  }
  const raw = config.baseURL;
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > MAX_BASE_URL_LENGTH ||
    hasUnsafeChars(raw)
  ) {
    invalidConfig("baseURL 为空、过长或包含空白字符");
  }
  if (raw.includes("?") || raw.includes("#")) {
    invalidConfig("baseURL 不能包含查询串或片段");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalidConfig("baseURL 不是合法的绝对 URL");
  }
  if (url.username || url.password) {
    invalidConfig("baseURL 不能包含用户名或密码");
  }
  if (!url.hostname) {
    invalidConfig("baseURL 缺少主机名");
  }
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol !== "http:") {
    invalidConfig("baseURL 只允许 https（本机调试可用 http）");
  }
  if (!config.allowLocal) {
    invalidConfig("http 仅在 allowLocal=true 时允许，且只能指向本机");
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    invalidConfig("http 只能指向 127.0.0.1、localhost 或 [::1]");
  }
}

/** 将 baseURL 规范为 …/chat/completions；已带该后缀时不重复追加。 */
export function resolveEndpoint(baseURL: string): string {
  const url = new URL(baseURL);
  let path = url.pathname;
  while (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function validateMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    invalidRequest("消息列表不能为空");
  }
  return messages.map((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      ((message as ChatMessage).role !== "system" &&
        (message as ChatMessage).role !== "user") ||
      typeof (message as ChatMessage).content !== "string" ||
      !(message as ChatMessage).content.trim()
    ) {
      return invalidRequest("消息必须包含 system/user 角色和非空文本");
    }
    return {
      role: (message as ChatMessage).role,
      content: (message as ChatMessage).content,
    };
  });
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    invalidRequest(`${label} 必须是正整数`);
  }
  return value as number;
}

function tokenCount(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function statusError(status: number): ExplorerError {
  if (status === 401 || status === 403) {
    return new ExplorerError(
      "AUTH_FAILED",
      `模型服务拒绝了 API 密钥（HTTP ${status}）`,
    );
  }
  if (status === 404) {
    return new ExplorerError("ENDPOINT_NOT_FOUND", "模型服务地址不存在（HTTP 404）");
  }
  if (status === 429) {
    return new ExplorerError("RATE_LIMITED", "模型服务限流或额度不足（HTTP 429）");
  }
  if (status >= 300 && status < 400) {
    return new ExplorerError(
      "REDIRECT_REFUSED",
      `模型服务要求重定向，已拒绝（HTTP ${status}）`,
    );
  }
  if (status >= 400 && status < 500) {
    return new ExplorerError("REQUEST_REJECTED", `模型服务拒绝请求（HTTP ${status}）`);
  }
  return new ExplorerError("UPSTREAM_ERROR", `模型服务异常（HTTP ${status}）`);
}

function parseResponse(text: string): ChatResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExplorerError("INVALID_RESPONSE", "模型服务返回的不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExplorerError("INVALID_RESPONSE", "模型服务返回的 JSON 结构无效");
  }
  const record = parsed as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) {
    throw new ExplorerError("UPSTREAM_ERROR", "模型服务返回了错误对象");
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ExplorerError("INVALID_RESPONSE", "模型响应缺少 choices");
  }
  const first = choices[0] as Record<string, unknown> | null;
  const message =
    first && typeof first === "object"
      ? (first.message as Record<string, unknown> | null | undefined)
      : undefined;
  if (!message || typeof message !== "object") {
    throw new ExplorerError("INVALID_RESPONSE", "模型响应缺少 message");
  }
  const finishReason = first?.finish_reason;
  if (finishReason === "content_filter") {
    throw new ExplorerError("CONTENT_FILTERED", "模型服务因内容策略拦截了输出");
  }
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    throw new ExplorerError("UNSUPPORTED_RESPONSE", "模型返回了工具调用，本插件不支持");
  }
  const content = message.content;
  if (content === null || content === undefined) {
    throw new ExplorerError("EMPTY_RESPONSE", "模型未返回文本内容（content 为空）");
  }
  if (typeof content !== "string") {
    throw new ExplorerError("INVALID_RESPONSE", "模型响应 content 不是字符串");
  }
  if (!content.trim()) {
    throw new ExplorerError("EMPTY_RESPONSE", "模型返回了空文本");
  }
  if (finishReason === "length") {
    throw new ExplorerError(
      "OUTPUT_LIMIT_REACHED",
      "模型输出达到 token 上限而被截断，请提高输出上限或缩小输入",
    );
  }
  const usageRecord =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : undefined;
  const usage: Usage = {
    inputTokens: tokenCount(usageRecord?.prompt_tokens),
    outputTokens: tokenCount(usageRecord?.completion_tokens),
  };
  return { content, usage };
}

function defaultFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new ExplorerError("NETWORK_UNAVAILABLE", "当前环境没有可用的 fetch");
  }
  return candidate as FetchLike;
}

/**
 * OpenAI-compatible 非流式 Chat Completions 传输层。
 * 无自动重试、无连通性探测、无工具调用；错误信息不含响应正文、响应头或密钥。
 */
export function createTransport(
  getKey: KeyResolver,
  fetchImpl?: FetchLike,
): ChatTransport {
  if (typeof getKey !== "function") {
    throw new ExplorerError("INVALID_ARGUMENT", "createTransport 需要密钥解析函数");
  }
  return {
    async complete(request: ChatRequest): Promise<ChatResponse> {
      if (!request || typeof request !== "object") {
        invalidRequest("请求对象无效");
      }
      validateModelConfig(request.config);
      const messages = validateMessages(request.messages);
      const maxOutputTokens = positiveInteger(
        request.maxOutputTokens,
        "输出 token 上限",
      );
      const timeoutMs = positiveInteger(request.timeoutMs, "超时时间");
      const signal = request.signal;
      if (!signal || typeof signal.aborted !== "boolean") {
        invalidRequest("请求缺少 AbortSignal");
      }
      if (signal.aborted) {
        throw new ExplorerError("ABORTED", "请求在发送前已被取消");
      }
      const fetchFn = fetchImpl ?? defaultFetch();
      const endpoint = resolveEndpoint(request.config.baseURL);

      let key: string;
      try {
        key = await getKey(request.config.id);
      } catch (error) {
        if (error instanceof ExplorerError) {
          throw error;
        }
        throw new ExplorerError("CREDENTIAL_UNAVAILABLE", "无法读取该模型的 API 密钥");
      }
      if (typeof key !== "string" || !key.trim()) {
        throw new ExplorerError("CREDENTIAL_MISSING", "尚未为该模型配置 API 密钥");
      }

      const body = JSON.stringify({
        model: request.config.model,
        messages,
        stream: false,
        [request.config.outputTokenField]: maxOutputTokens,
      });
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const mapFailure = (): ExplorerError => {
        if (timedOut) {
          return new ExplorerError("TIMEOUT", `模型请求超时（${timeoutMs}ms）`);
        }
        if (signal.aborted) {
          return new ExplorerError("ABORTED", "模型请求已取消");
        }
        return new ExplorerError("NETWORK_ERROR", "无法连接模型服务或连接被中断");
      };

      let text: string | undefined;
      try {
        let response: FetchResponseLike;
        try {
          response = await fetchFn(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key.trim()}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body,
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            keepalive: false,
          });
        } catch {
          throw mapFailure();
        }
        if (!response || typeof response.status !== "number") {
          throw new ExplorerError("INVALID_RESPONSE", "模型服务未返回有效响应");
        }
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status);
        }
        const declared = Number(response.headers?.get?.("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
          throw new ExplorerError("RESPONSE_TOO_LARGE", "模型响应超过本地大小上限");
        }
        try {
          text = await response.text();
        } catch {
          throw mapFailure();
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      if (typeof text !== "string") {
        throw new ExplorerError("INVALID_RESPONSE", "模型服务未返回文本正文");
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        throw new ExplorerError("RESPONSE_TOO_LARGE", "模型响应超过本地大小上限");
      }
      return parseResponse(text);
    },
  };
}
