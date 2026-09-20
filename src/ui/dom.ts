export type Child = Node | string | null | undefined | false;

export interface Attrs {
  [key: string]: string | number | boolean | EventListener | undefined;
}

const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "selected"]);

/** 只用 textContent 挂载文本；模型输出和文献内容都不会被当成 HTML 解析。 */
export function h(
  doc: Document,
  tag: string,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElement {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (key === "className") {
      element.className = String(value);
      continue;
    }
    if (PROPERTY_KEYS.has(key)) {
      (element as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    element.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return element;
}

export function clear(element: Element): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

export function field(doc: Document, label: string, input: HTMLElement): HTMLElement {
  return h(doc, "label", { className: "field" }, [h(doc, "span", {}, [label]), input]);
}

export function textarea(
  doc: Document,
  value: string,
  attrs: Attrs = {},
): HTMLTextAreaElement {
  const element = h(doc, "textarea", attrs) as HTMLTextAreaElement;
  element.value = value;
  return element;
}

export function input(
  doc: Document,
  type: string,
  value: string,
  attrs: Attrs = {},
): HTMLInputElement {
  const element = h(doc, "input", { type, ...attrs }) as HTMLInputElement;
  element.value = value;
  return element;
}

export function select(
  doc: Document,
  options: Array<{ value: string; label: string }>,
  value: string,
  attrs: Attrs = {},
): HTMLSelectElement {
  const element = h(doc, "select", attrs) as HTMLSelectElement;
  for (const option of options) {
    element.append(h(doc, "option", { value: option.value }, [option.label]));
  }
  element.value = value;
  return element;
}

export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
