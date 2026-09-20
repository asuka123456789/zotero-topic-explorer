import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";

export function getLocaleID(id: FluentMessageId): string {
  return `${config.addonRef}-${id}`;
}

export function isWindowAlive(win?: Window | null): win is Window {
  return !!win && !Components.utils.isDeadWrapper(win) && !win.closed;
}

/** 只记录错误类别，不把可能含凭据或原文的异常正文写入日志。 */
export function logInternalError(scope: string, error: unknown): void {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : typeof error;
  let detail = "";
  try {
    if (Zotero.Prefs.get(`${config.prefsPrefix}.debug.verbose`, true) === true) {
      detail = ` ${String(error)}`;
    }
  } catch {
    // 偏好不可用时保持静默
  }
  ztoolkit.log(`[${scope}] 内部错误：${name}${detail}`, "error");
}
