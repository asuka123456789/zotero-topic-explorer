import { type Budget, DEFAULT_BUDGET } from "../domain/types.ts";
import { ExplorerError } from "../domain/errors.ts";

export const BUDGET_LIMITS = {
  minRequests: 1,
  maxRequests: 12,
  minInputBytes: 1024,
  maxInputBytes: 500000,
  minOutputTokens: 256,
  maxOutputTokens: 16384,
  minRequestTimeoutMs: 5000,
  maxRequestTimeoutMs: 600000,
  minDurationMs: 10000,
  maxDurationMs: 1800000,
} as const;

export function validateBudget(budget?: Budget): Budget {
  if (!budget) {
    return { ...DEFAULT_BUDGET };
  }

  if (
    typeof budget.maxRequests !== "number" ||
    budget.maxRequests < BUDGET_LIMITS.minRequests ||
    budget.maxRequests > BUDGET_LIMITS.maxRequests
  ) {
    throw new ExplorerError(
      "INVALID_BUDGET",
      `maxRequests 必须在 ${BUDGET_LIMITS.minRequests} 到 ${BUDGET_LIMITS.maxRequests} 之间，当前为 ${budget.maxRequests}`,
    );
  }

  if (
    typeof budget.maxInputBytes !== "number" ||
    budget.maxInputBytes < BUDGET_LIMITS.minInputBytes ||
    budget.maxInputBytes > BUDGET_LIMITS.maxInputBytes
  ) {
    throw new ExplorerError(
      "INVALID_BUDGET",
      `maxInputBytes 必须在 ${BUDGET_LIMITS.minInputBytes} 到 ${BUDGET_LIMITS.maxInputBytes} 之间，当前为 ${budget.maxInputBytes}`,
    );
  }

  if (
    typeof budget.maxOutputTokens !== "number" ||
    budget.maxOutputTokens < BUDGET_LIMITS.minOutputTokens ||
    budget.maxOutputTokens > BUDGET_LIMITS.maxOutputTokens
  ) {
    throw new ExplorerError(
      "INVALID_BUDGET",
      `maxOutputTokens 必须在 ${BUDGET_LIMITS.minOutputTokens} 到 ${BUDGET_LIMITS.maxOutputTokens} 之间，当前为 ${budget.maxOutputTokens}`,
    );
  }

  if (
    typeof budget.requestTimeoutMs !== "number" ||
    budget.requestTimeoutMs < BUDGET_LIMITS.minRequestTimeoutMs ||
    budget.requestTimeoutMs > BUDGET_LIMITS.maxRequestTimeoutMs
  ) {
    throw new ExplorerError(
      "INVALID_BUDGET",
      `requestTimeoutMs 必须在 ${BUDGET_LIMITS.minRequestTimeoutMs} 到 ${BUDGET_LIMITS.maxRequestTimeoutMs} 之间，当前为 ${budget.requestTimeoutMs}`,
    );
  }

  if (
    typeof budget.maxDurationMs !== "number" ||
    budget.maxDurationMs < BUDGET_LIMITS.minDurationMs ||
    budget.maxDurationMs > BUDGET_LIMITS.maxDurationMs
  ) {
    throw new ExplorerError(
      "INVALID_BUDGET",
      `maxDurationMs 必须在 ${BUDGET_LIMITS.minDurationMs} 到 ${BUDGET_LIMITS.maxDurationMs} 之间，当前为 ${budget.maxDurationMs}`,
    );
  }

  return { ...budget };
}

export function checkInputByteLimit(text: string, maxBytes: number): number {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    throw new ExplorerError(
      "BUDGET_INPUT_EXCEEDED",
      `输入大小 (${bytes} 字节) 超出预算上限 (${maxBytes} 字节)`,
    );
  }
  return bytes;
}
