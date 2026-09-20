export class ExplorerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExplorerError";
    this.code = code;
  }
}
export function safeError(error: unknown): { code: string; message: string } {
  return error instanceof ExplorerError
    ? { code: error.code, message: error.message }
    : {
        code: "INTERNAL_ERROR",
        message: "操作未完成。请检查本地环境；未记录可能含凭据或原文的异常正文。",
      };
}
export function newID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
