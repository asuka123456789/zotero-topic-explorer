import {
  type ChatRequest,
  type ChatResponse,
  type ChatTransport,
  type Usage,
} from "../../src/domain/types.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

export interface MockTransportHandler {
  (request: ChatRequest, callIndex: number): Promise<ChatResponse> | ChatResponse;
}

export class MockTransport implements ChatTransport {
  public requests: ChatRequest[] = [];
  public responses: Map<string, ChatResponse> = new Map();
  public defaultUsage: Usage = { inputTokens: 100, outputTokens: 200 };
  public customHandler?: MockTransportHandler;
  public delayMs = 0;

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const callIndex = this.requests.length;
    this.requests.push(request);

    if (request.signal.aborted) {
      throw new ExplorerError("ABORTED", "请求已被中止");
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.delayMs);
        request.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new ExplorerError("ABORTED", "请求已由信号中止"));
        });
      });
    }

    if (this.customHandler) {
      return await this.customHandler(request, callIndex);
    }

    // Default responses by looking at system prompt role
    const systemMsg = request.messages.find((m) => m.role === "system")?.content || "";
    for (const [key, resp] of this.responses.entries()) {
      if (systemMsg.includes(key)) {
        return resp;
      }
    }

    return {
      content: JSON.stringify({ message: "mock response" }),
      usage: this.defaultUsage,
    };
  }

  reset(): void {
    this.requests = [];
    this.responses.clear();
    this.customHandler = undefined;
    this.delayMs = 0;
  }
}
