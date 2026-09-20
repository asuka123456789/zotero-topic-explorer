import { expect } from "chai";
import {
  MAX_RESPONSE_CHARS,
  createTransport,
  resolveEndpoint,
  validateModelConfig,
  type FetchLike,
  type FetchResponseLike,
  type TransportRequestInit,
} from "../../src/providers/openaiCompatible.ts";
import { ExplorerError } from "../../src/domain/errors.ts";
import type { ChatRequest, ModelConfig } from "../../src/domain/types.ts";

const SECRET = "sk-SECRET-KEY-0001";

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "gpt-main",
    label: "Main",
    baseURL: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    outputTokenField: "max_tokens",
    allowLocal: false,
    ...overrides,
  };
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    config: config(),
    messages: [
      { role: "system", content: "你是选题助手。" },
      { role: "user", content: "请给出候选题。" },
    ],
    maxOutputTokens: 800,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get: (name) => (name === "content-length" ? String(text.length) : null),
    },
    text: async () => text,
  };
}

interface Recorded {
  url: string;
  init: TransportRequestInit;
}

function fakeFetch(
  handler: (url: string, init: TransportRequestInit) => Promise<FetchResponseLike>,
) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<ExplorerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(ExplorerError);
    expect((error as ExplorerError).code).to.equal(code);
    expect((error as ExplorerError).message).to.not.include(SECRET);
    return error as ExplorerError;
  }
  return expect.fail(`应当抛出 ${code}`);
}

describe("OpenAI-compatible 传输层", function () {
  describe("validateModelConfig", function () {
    it("接受 https，接受 allowLocal 下的本机 http", function () {
      expect(() => validateModelConfig(config())).to.not.throw();
      for (const host of ["127.0.0.1:8080", "localhost:11434", "[::1]:1234"]) {
        expect(() =>
          validateModelConfig(
            config({ baseURL: `http://${host}/v1`, allowLocal: true }),
          ),
        ).to.not.throw();
      }
    });

    it("拒绝未启用 allowLocal 的 http、非本机 http 与危险协议", function () {
      const bad: Array<Partial<ModelConfig>> = [
        { baseURL: "http://127.0.0.1:8080/v1", allowLocal: false },
        { baseURL: "http://api.example.com/v1", allowLocal: true },
        { baseURL: "http://127.0.0.1.evil.example/v1", allowLocal: true },
        { baseURL: "ftp://api.example.com/v1" },
        { baseURL: "file:///C:/models" },
        { baseURL: "javascript:alert(1)" },
        { baseURL: "chrome://zotero/content" },
      ];
      for (const overrides of bad) {
        expect(
          () => validateModelConfig(config(overrides)),
          overrides.baseURL,
        ).to.throw(ExplorerError);
      }
    });

    it("拒绝 userinfo、查询串、片段、空白与无效 URL", function () {
      const bad = [
        "https://user:pw@api.example.com/v1",
        "https://user@api.example.com/v1",
        "https://api.example.com/v1?key=1",
        "https://api.example.com/v1#frag",
        "https://api.example.com/v1 ",
        "api.example.com/v1",
        "",
      ];
      for (const baseURL of bad) {
        try {
          validateModelConfig(config({ baseURL }));
          expect.fail(`应当拒绝 ${baseURL}`);
        } catch (error) {
          expect((error as ExplorerError).code, baseURL).to.equal(
            "INVALID_MODEL_CONFIG",
          );
        }
      }
    });

    it("拒绝无效的 outputTokenField、模型名与 ID", function () {
      const bad: Array<Partial<ModelConfig>> = [
        { outputTokenField: "max_output_tokens" as ModelConfig["outputTokenField"] },
        { model: "" },
        { model: "gpt 4" },
        { id: "bad id" },
        { allowLocal: "yes" as unknown as boolean },
      ];
      for (const overrides of bad) {
        expect(() => validateModelConfig(config(overrides))).to.throw(ExplorerError);
      }
    });
  });

  describe("resolveEndpoint", function () {
    it("规范化到 /chat/completions，不重复追加，去掉多余斜杠", function () {
      expect(resolveEndpoint("https://api.example.com/v1")).to.equal(
        "https://api.example.com/v1/chat/completions",
      );
      expect(resolveEndpoint("https://api.example.com/v1/")).to.equal(
        "https://api.example.com/v1/chat/completions",
      );
      expect(resolveEndpoint("https://api.example.com/v1/chat/completions")).to.equal(
        "https://api.example.com/v1/chat/completions",
      );
      expect(resolveEndpoint("https://api.example.com")).to.equal(
        "https://api.example.com/chat/completions",
      );
      expect(resolveEndpoint("http://[::1]:8080/openai/v1")).to.equal(
        "http://[::1]:8080/openai/v1/chat/completions",
      );
    });
  });

  describe("createTransport（非流式 Chat Completions）", function () {
    const getKey = async (configId: string) => {
      expect(configId).to.equal("gpt-main");
      return SECRET;
    };

    it("发送正确的 POST 请求并解析 content 与 usage", async function () {
      const { calls, fetchImpl } = fakeFetch(async () =>
        jsonResponse({
          id: "chatcmpl-1",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: '{"candidates":[]}' },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
      );
      const transport = createTransport(getKey, fetchImpl);
      const response = await transport.complete(request());

      expect(response).to.deep.equal({
        content: '{"candidates":[]}',
        usage: { inputTokens: 120, outputTokens: 30 },
      });
      expect(calls).to.have.lengthOf(1);
      const { url, init } = calls[0];
      expect(url).to.equal("https://api.example.com/v1/chat/completions");
      expect(init.method).to.equal("POST");
      expect(init.redirect).to.equal("error");
      expect(init.credentials).to.equal("omit");
      expect(init.cache).to.equal("no-store");
      expect(init.referrerPolicy).to.equal("no-referrer");
      expect(init.headers).to.deep.equal({
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      });
      expect(JSON.parse(init.body)).to.deep.equal({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "你是选题助手。" },
          { role: "user", content: "请给出候选题。" },
        ],
        stream: false,
        max_tokens: 800,
      });
      expect(init.signal).to.be.instanceOf(AbortSignal);
      expect(init.signal.aborted).to.equal(false);
    });

    it("按 outputTokenField 使用 max_completion_tokens；缺 usage 时记为 null", async function () {
      const { calls, fetchImpl } = fakeFetch(async () =>
        jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      );
      const transport = createTransport(getKey, fetchImpl);
      const response = await transport.complete(
        request({ config: config({ outputTokenField: "max_completion_tokens" }) }),
      );
      expect(response.usage).to.deep.equal({ inputTokens: null, outputTokens: null });
      const body = JSON.parse(calls[0].init.body);
      expect(body.max_completion_tokens).to.equal(800);
      expect(body).to.not.have.property("max_tokens");
    });

    it("响应结构异常：缺 choices、content 为 null、非字符串、超限截断", async function () {
      const cases: Array<[unknown, string]> = [
        [{ choices: [] }, "INVALID_RESPONSE"],
        [{ result: "x" }, "INVALID_RESPONSE"],
        [{ choices: [{ message: { content: null } }] }, "EMPTY_RESPONSE"],
        [{ choices: [{ message: { content: "   " } }] }, "EMPTY_RESPONSE"],
        [{ choices: [{ message: { content: ["a"] } }] }, "INVALID_RESPONSE"],
        [
          { choices: [{ message: { content: "part" }, finish_reason: "length" }] },
          "OUTPUT_LIMIT_REACHED",
        ],
        [
          { choices: [{ message: { content: "x" }, finish_reason: "content_filter" }] },
          "CONTENT_FILTERED",
        ],
        [
          {
            choices: [
              {
                message: { content: null, tool_calls: [] },
                finish_reason: "tool_calls",
              },
            ],
          },
          "UNSUPPORTED_RESPONSE",
        ],
        [{ error: { message: "bad key sk-SECRET-KEY-0001" } }, "UPSTREAM_ERROR"],
        ["not json {", "INVALID_RESPONSE"],
        ["[1,2]", "INVALID_RESPONSE"],
      ];
      for (const [body, code] of cases) {
        const { fetchImpl } = fakeFetch(async () => jsonResponse(body));
        const transport = createTransport(getKey, fetchImpl);
        const error = await expectCode(transport.complete(request()), code);
        expect(error.message).to.not.include("bad key");
      }
    });

    it("HTTP 错误码映射为短中文错误，不含响应正文与密钥，且不重试", async function () {
      const cases: Array<[number, string]> = [
        [401, "AUTH_FAILED"],
        [403, "AUTH_FAILED"],
        [404, "ENDPOINT_NOT_FOUND"],
        [429, "RATE_LIMITED"],
        [400, "REQUEST_REJECTED"],
        [302, "REDIRECT_REFUSED"],
        [500, "UPSTREAM_ERROR"],
        [503, "UPSTREAM_ERROR"],
      ];
      for (const [status, code] of cases) {
        const { calls, fetchImpl } = fakeFetch(async () =>
          jsonResponse(
            { error: { message: `leak ${SECRET} x-request-id: abc` } },
            status,
          ),
        );
        const transport = createTransport(getKey, fetchImpl);
        const error = await expectCode(transport.complete(request()), code);
        expect(error.message).to.not.include("leak");
        expect(error.message).to.not.include("x-request-id");
        expect(calls, `status ${status}`).to.have.lengthOf(1);
      }
    });

    it("网络异常映射为 NETWORK_ERROR，不泄露底层错误文本，不重试", async function () {
      const { calls, fetchImpl } = fakeFetch(async () => {
        throw new TypeError(`fetch failed: ECONNREFUSED 10.0.0.9 ${SECRET}`);
      });
      const transport = createTransport(getKey, fetchImpl);
      const error = await expectCode(transport.complete(request()), "NETWORK_ERROR");
      expect(error.message).to.not.include("ECONNREFUSED");
      expect(error.message).to.not.include("10.0.0.9");
      expect(calls).to.have.lengthOf(1);
    });

    it("超时：到 timeoutMs 后中止底层请求并抛 TIMEOUT", async function () {
      const { calls, fetchImpl } = fakeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const transport = createTransport(getKey, fetchImpl);
      const started = Date.now();
      const error = await expectCode(
        transport.complete(request({ timeoutMs: 40 })),
        "TIMEOUT",
      );
      expect(Date.now() - started).to.be.lessThan(2_000);
      expect(error.message).to.include("40ms");
      expect(calls[0].init.signal.aborted).to.equal(true);
    });

    it("取消：外部 AbortSignal 触发时中止底层请求并抛 ABORTED", async function () {
      const { calls, fetchImpl } = fakeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const transport = createTransport(getKey, fetchImpl);
      const controller = new AbortController();
      const pending = transport.complete(request({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 10);
      await expectCode(pending, "ABORTED");
      expect(calls[0].init.signal.aborted).to.equal(true);
    });

    it("信号已中止时不发请求；密钥缺失或读取失败时不发请求", async function () {
      const { calls, fetchImpl } = fakeFetch(async () =>
        jsonResponse({ choices: [{ message: { content: "x" } }] }),
      );
      const aborted = new AbortController();
      aborted.abort();
      const transport = createTransport(getKey, fetchImpl);
      await expectCode(
        transport.complete(request({ signal: aborted.signal })),
        "ABORTED",
      );

      const missing = createTransport(async () => "", fetchImpl);
      await expectCode(missing.complete(request()), "CREDENTIAL_MISSING");

      const failing = createTransport(async () => {
        throw new Error("keychain locked");
      }, fetchImpl);
      const error = await expectCode(
        failing.complete(request()),
        "CREDENTIAL_UNAVAILABLE",
      );
      expect(error.message).to.not.include("keychain");

      const passthrough = createTransport(async () => {
        throw new ExplorerError("CREDENTIAL_MISSING", "尚未配置");
      }, fetchImpl);
      await expectCode(passthrough.complete(request()), "CREDENTIAL_MISSING");
      expect(calls).to.deep.equal([]);
    });

    it("发送前校验配置与请求参数，拒绝不安全 baseURL 与空消息", async function () {
      const { calls, fetchImpl } = fakeFetch(async () =>
        jsonResponse({ choices: [{ message: { content: "x" } }] }),
      );
      const transport = createTransport(getKey, fetchImpl);
      await expectCode(
        transport.complete(
          request({ config: config({ baseURL: "http://api.example.com/v1" }) }),
        ),
        "INVALID_MODEL_CONFIG",
      );
      await expectCode(
        transport.complete(request({ messages: [] })),
        "INVALID_REQUEST",
      );
      await expectCode(
        transport.complete(
          request({ messages: [{ role: "assistant" as "user", content: "x" }] }),
        ),
        "INVALID_REQUEST",
      );
      await expectCode(
        transport.complete(request({ maxOutputTokens: 0 })),
        "INVALID_REQUEST",
      );
      await expectCode(
        transport.complete(request({ timeoutMs: -1 })),
        "INVALID_REQUEST",
      );
      expect(calls).to.deep.equal([]);
    });

    it("响应体超过本地上限时拒绝", async function () {
      const huge = "x".repeat(MAX_RESPONSE_CHARS + 1);
      const { fetchImpl } = fakeFetch(async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => huge,
      }));
      const transport = createTransport(getKey, fetchImpl);
      await expectCode(transport.complete(request()), "RESPONSE_TOO_LARGE");

      const declared = fakeFetch(async () => ({
        status: 200,
        headers: { get: () => String(MAX_RESPONSE_CHARS + 1) },
        text: async () => {
          throw new Error("should not read body");
        },
      }));
      const transport2 = createTransport(getKey, declared.fetchImpl);
      await expectCode(transport2.complete(request()), "RESPONSE_TOO_LARGE");
    });
  });
});
