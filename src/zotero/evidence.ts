import type {
  Evidence,
  EvidenceResult,
  SelectionTarget,
  SourceRef,
} from "../domain/types.ts";
import { ExplorerError } from "../domain/errors.ts";
import { hashText, utf8ByteLength } from "../domain/hash.ts";

/** 单次最多处理的文献数量，与 selection.ts 的上限一致。 */
export const MAX_EVIDENCE_TARGETS = 20;
export const MAX_METADATA_CHARS = 2_000;
export const MAX_ABSTRACT_CHARS = 6_000;
export const MAX_ANNOTATION_CHARS = 4_000;
export const MAX_FULLTEXT_CHARS = 4_000;
/** 只读取全文缓存文件开头的字节数；不会触发索引、OCR 或下载。 */
const MAX_FULLTEXT_READ_BYTES = 64 * 1024;
const MAX_CREATORS = 20;
const ZOTERO_KEY = /^[A-Z0-9]{8}$/;

/** Evidence.extraction 取值：记录证据的来源方式。 */
export const EXTRACTION = {
  metadata: "zotero_metadata",
  abstract: "zotero_field:abstractNote",
  annotation: "zotero_annotation",
  fulltextCache: "zotero_fulltext_cache",
} as const;

export interface ZoteroCreatorLike {
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode?: number;
}

/** 本模块用到的 Zotero.Item 子集；真实运行时与单测 fake 都满足该形状。 */
export interface ZoteroItemLike {
  id: number;
  key: string;
  libraryID: number;
  deleted?: boolean;
  parentItemKey?: string | false;
  parentItem?: ZoteroItemLike | null;
  isRegularItem(): boolean;
  isAttachment(): boolean;
  isFileAttachment?(): boolean;
  isPDFAttachment?(): boolean;
  getField(field: string): string;
  getExtraField?(field: string): string;
  getDisplayTitle?(): string;
  getCreators?(): ZoteroCreatorLike[];
  getAttachments?(includeTrashed?: boolean): number[];
  getAnnotations?(includeTrashed?: boolean): ZoteroItemLike[];
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
}

/** Zotero.Fulltext.getItemCacheFile 返回的 nsIFile 子集；刻意不暴露 path。 */
export interface ZoteroCacheFileLike {
  exists(): boolean;
  fileSize?: number;
}

export interface ZoteroPaneLike {
  selectItem(itemID: number, inLibraryRoot?: boolean): unknown;
}

export interface ZoteroRuntime {
  Items: {
    getByLibraryAndKeyAsync(
      libraryID: number,
      key: string,
    ): Promise<ZoteroItemLike | false>;
    get(id: number): ZoteroItemLike | false;
  };
  Fulltext?: { getItemCacheFile(item: ZoteroItemLike): ZoteroCacheFileLike };
  File?: {
    getContentsAsync(
      source: unknown,
      charset?: string,
      maxLength?: number,
    ): Promise<string> | string;
  };
  Reader?: {
    open(
      itemID: number,
      location?: { annotationKey?: string },
      options?: { allowDuplicate?: boolean },
    ): Promise<unknown>;
  };
  getActiveZoteroPane?(): ZoteroPaneLike | null;
  getMainWindow?(): { ZoteroPane?: ZoteroPaneLike | null } | null;
}

export interface EvidenceOptions {
  /** 注入的 Zotero 运行时；缺省使用全局 Zotero。 */
  zotero?: ZoteroRuntime;
  /** 证据编号起始值（默认 1）。与已有证据合并时传入 `已有数量 + 1` 以避免 ID 冲突。 */
  startIndex?: number;
}

export interface OpenSourceOptions {
  zotero?: ZoteroRuntime;
}

interface ClippedText {
  text: string;
  truncated: boolean;
}

interface CachedExcerpt extends ClippedText {
  start: number;
  end: number;
}

interface Position {
  pageLabel?: string;
  start?: number;
  end?: number;
}

function runtimeOf(options: { zotero?: ZoteroRuntime }): ZoteroRuntime {
  const runtime =
    options.zotero ?? (globalThis as unknown as { Zotero?: ZoteroRuntime }).Zotero;
  if (!runtime?.Items) {
    throw new ExplorerError("ZOTERO_UNAVAILABLE", "当前环境没有可用的 Zotero 运行时");
  }
  return runtime;
}

function idSequence(startIndex: number | undefined): () => string {
  if (startIndex !== undefined && (!Number.isInteger(startIndex) || startIndex < 1)) {
    throw new ExplorerError("INVALID_ARGUMENT", "startIndex 必须是不小于 1 的整数");
  }
  let next = startIndex ?? 1;
  return () => `E${next++}`;
}

function assertRef(libraryID: unknown, key: unknown, label: string): void {
  if (!Number.isInteger(libraryID) || (libraryID as number) < 0) {
    throw new ExplorerError("INVALID_TARGET", `${label} 的 libraryID 无效`);
  }
  if (typeof key !== "string" || !ZOTERO_KEY.test(key)) {
    throw new ExplorerError("INVALID_TARGET", `${label} 的条目 key 格式无效`);
  }
}

function validTargets(
  targets: SelectionTarget[],
  warnings: string[],
): SelectionTarget[] {
  if (!Array.isArray(targets)) {
    throw new ExplorerError("INVALID_TARGET", "文献目标必须是数组");
  }
  if (targets.length > MAX_EVIDENCE_TARGETS) {
    throw new ExplorerError(
      "SELECTION_LIMIT_EXCEEDED",
      `一次最多处理 ${MAX_EVIDENCE_TARGETS} 篇文献，当前 ${targets.length} 篇；请缩小选择范围`,
    );
  }
  const seen = new Set<string>();
  const result: SelectionTarget[] = [];
  for (const target of targets) {
    assertRef(target?.libraryID, target?.itemKey, "文献目标");
    const key = `${target.libraryID}:${target.itemKey}`;
    if (seen.has(key)) {
      warnings.push(`重复的文献目标 ${target.itemKey} 已合并`);
      continue;
    }
    seen.add(key);
    result.push(target);
  }
  if (result.length === 0) {
    warnings.push("没有可收集的文献目标");
  }
  return result;
}

function refOf(target: SelectionTarget): SourceRef {
  return { libraryID: target.libraryID, itemKey: target.itemKey };
}

function short(title: string): string {
  return title.length > 60 ? `${title.slice(0, 60)}…` : title;
}

/** 警告中的文献标签：与证据 title 一致，优先条目当前题名，其次选择时的题名，最后 key。 */
function labelOf(target: SelectionTarget, item?: ZoteroItemLike): string {
  const title = item
    ? titleOf(item, target)
    : normalize(typeof target.title === "string" ? target.title : "");
  return short(title || target.itemKey);
}

function field(item: ZoteroItemLike, name: string): string {
  try {
    const value = item.getField(name);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function extraField(item: ZoteroItemLike, name: string): string {
  if (typeof item.getExtraField !== "function") {
    return "";
  }
  try {
    const value = item.getExtraField(name);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}

function clip(text: string, maximum: number): ClippedText {
  return text.length > maximum
    ? { text: text.slice(0, maximum).trimEnd(), truncated: true }
    : { text, truncated: false };
}

function isPDF(item: ZoteroItemLike): boolean {
  try {
    return item.isAttachment() && item.isPDFAttachment?.() === true;
  } catch {
    return false;
  }
}

function titleOf(item: ZoteroItemLike, target: SelectionTarget): string {
  let title = normalize(field(item, "title"));
  if (!title && typeof item.getDisplayTitle === "function") {
    try {
      title = normalize(item.getDisplayTitle() ?? "");
    } catch {
      title = "";
    }
  }
  if (!title && typeof target.title === "string") {
    title = normalize(target.title);
  }
  return title || "未命名文献";
}

function formatCreators(item: ZoteroItemLike): string {
  if (typeof item.getCreators !== "function") {
    return "";
  }
  let creators: ZoteroCreatorLike[];
  try {
    creators = item.getCreators() ?? [];
  } catch {
    return "";
  }
  const names = creators
    .map((creator) => {
      if (creator.fieldMode === 1 || creator.name) {
        return normalize(creator.name ?? creator.lastName ?? "");
      }
      return normalize([creator.firstName, creator.lastName].filter(Boolean).join(" "));
    })
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return "";
  }
  const shown = names.slice(0, MAX_CREATORS).join("; ");
  return names.length > MAX_CREATORS ? `${shown} 等${names.length}人` : shown;
}

/** 白名单题录摘要：仅题名、作者、日期、DOI。 */
function metadataSummary(item: ZoteroItemLike, title: string): string {
  const lines = [`题名：${title}`];
  const creators = formatCreators(item);
  if (creators) {
    lines.push(`作者：${creators}`);
  }
  const date = normalize(field(item, "date"));
  if (date) {
    lines.push(`日期：${date}`);
  }
  const doi = normalize(field(item, "DOI") || extraField(item, "DOI"));
  if (doi) {
    lines.push(`DOI：${doi}`);
  }
  return lines.join("\n");
}

function makeEvidence(
  id: string,
  ref: SourceRef,
  kind: Evidence["kind"],
  title: string,
  body: ClippedText,
  extraction: string,
  position: Position = {},
): Evidence {
  const evidence: Evidence = {
    ...ref,
    id,
    kind,
    title,
    text: body.text,
    hash: hashText(body.text),
    extraction,
    truncated: body.truncated,
  };
  if (position.pageLabel !== undefined) {
    evidence.pageLabel = position.pageLabel;
  }
  if (position.start !== undefined && position.end !== undefined) {
    evidence.start = position.start;
    evidence.end = position.end;
  }
  return evidence;
}

async function resolveItem(
  runtime: ZoteroRuntime,
  target: SelectionTarget,
  warnings: string[],
): Promise<ZoteroItemLike | null> {
  let item: ZoteroItemLike | false;
  try {
    item = await runtime.Items.getByLibraryAndKeyAsync(
      target.libraryID,
      target.itemKey,
    );
  } catch {
    warnings.push(`《${labelOf(target)}》读取失败，已跳过`);
    return null;
  }
  if (!item) {
    warnings.push(`《${labelOf(target)}》在文库中不存在，已跳过`);
    return null;
  }
  if (item.deleted === true) {
    warnings.push(`《${labelOf(target, item)}》已在回收站，已跳过`);
    return null;
  }
  let acceptable: boolean;
  try {
    acceptable = item.isRegularItem() || isPDF(item);
  } catch {
    acceptable = false;
  }
  if (!acceptable) {
    warnings.push(`《${labelOf(target, item)}》不是文献条目或独立 PDF，已跳过`);
    return null;
  }
  return item;
}

function childAttachments(
  runtime: ZoteroRuntime,
  item: ZoteroItemLike,
): ZoteroItemLike[] {
  if (typeof item.getAttachments !== "function") {
    return [];
  }
  let ids: number[];
  try {
    ids = item.getAttachments(false) ?? [];
  } catch {
    return [];
  }
  const attachments: ZoteroItemLike[] = [];
  for (const id of ids) {
    const attachment = runtime.Items.get(id);
    if (attachment && attachment.deleted !== true && attachment.isAttachment()) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

function annotationsOf(attachment: ZoteroItemLike): ZoteroItemLike[] {
  if (typeof attachment.getAnnotations !== "function") {
    return [];
  }
  if (
    typeof attachment.isFileAttachment === "function" &&
    !attachment.isFileAttachment()
  ) {
    return [];
  }
  try {
    return [...(attachment.getAnnotations(false) ?? [])]
      .filter((annotation) => annotation && annotation.deleted !== true)
      .sort((left, right) =>
        (left.annotationSortIndex ?? "").localeCompare(right.annotationSortIndex ?? ""),
      );
  } catch {
    return [];
  }
}

/** 批注正文：高亮原文在前，用户评论以「【批注】」标记，二者都保持原文。 */
function annotationBody(annotation: ZoteroItemLike): string {
  const text = normalize(annotation.annotationText ?? "");
  const comment = normalize(annotation.annotationComment ?? "");
  if (text && comment) {
    return `${text}\n\n【批注】${comment}`;
  }
  if (text) {
    return text;
  }
  return comment ? `【批注】${comment}` : "";
}

function pageLabelOf(annotation: ZoteroItemLike): string | undefined {
  const label = annotation.annotationPageLabel;
  return typeof label === "string" && label.trim() ? label : undefined;
}

/**
 * 只读取 Zotero 已生成的 .zotero-ft-cache 开头片段。
 * start/end 是相对缓存文本的字符偏移；缓存不含页码，因此不设置 pageLabel。
 */
async function readCachedExcerpt(
  runtime: ZoteroRuntime,
  attachment: ZoteroItemLike,
  label: string,
  warnings: string[],
  state: { apiWarned: boolean },
): Promise<CachedExcerpt | null> {
  const fulltext = runtime.Fulltext;
  const file = runtime.File;
  if (
    typeof fulltext?.getItemCacheFile !== "function" ||
    typeof file?.getContentsAsync !== "function"
  ) {
    if (!state.apiWarned) {
      warnings.push("Zotero 全文缓存接口不可用，未提供全文片段");
      state.apiWarned = true;
    }
    return null;
  }
  let cacheFile: ZoteroCacheFileLike;
  let exists: boolean;
  try {
    cacheFile = fulltext.getItemCacheFile(attachment);
    exists = cacheFile.exists();
  } catch {
    warnings.push(`《${label}》的全文缓存无法访问，已跳过全文片段`);
    return null;
  }
  if (!exists) {
    warnings.push(
      `《${label}》的 PDF 尚无 Zotero 全文缓存（未建立索引），已跳过全文片段`,
    );
    return null;
  }
  let raw: string;
  try {
    raw = String(
      await file.getContentsAsync(cacheFile, "utf-8", MAX_FULLTEXT_READ_BYTES),
    );
  } catch {
    warnings.push(`《${label}》的全文缓存读取失败，已跳过全文片段`);
    return null;
  }
  const start = raw.length - raw.trimStart().length;
  const body = raw.slice(start).trimEnd();
  const excerpt = body.slice(0, MAX_FULLTEXT_CHARS).replace(/�+$/u, "").trimEnd();
  if (!excerpt) {
    warnings.push(`《${label}》的全文缓存为空，已跳过全文片段`);
    return null;
  }
  const readCapped =
    (typeof cacheFile.fileSize === "number" &&
      cacheFile.fileSize > MAX_FULLTEXT_READ_BYTES) ||
    utf8ByteLength(raw) >= MAX_FULLTEXT_READ_BYTES;
  return {
    text: excerpt,
    truncated: readCapped || body.length > excerpt.length,
    start,
    end: start + excerpt.length,
  };
}

/** 默认证据：每篇文献一条白名单题录摘要，另有摘要时再加一条 abstract。 */
export async function collectEvidence(
  targets: SelectionTarget[],
  options: EvidenceOptions = {},
): Promise<EvidenceResult> {
  const runtime = runtimeOf(options);
  const nextId = idSequence(options.startIndex);
  const warnings: string[] = [];
  const evidence: Evidence[] = [];
  for (const target of validTargets(targets, warnings)) {
    const item = await resolveItem(runtime, target, warnings);
    if (!item) {
      continue;
    }
    const title = titleOf(item, target);
    const ref = refOf(target);
    evidence.push(
      makeEvidence(
        nextId(),
        ref,
        "metadata",
        title,
        clip(metadataSummary(item, title), MAX_METADATA_CHARS),
        EXTRACTION.metadata,
      ),
    );
    const abstract = normalize(field(item, "abstractNote"));
    if (abstract) {
      evidence.push(
        makeEvidence(
          nextId(),
          ref,
          "abstract",
          title,
          clip(abstract, MAX_ABSTRACT_CHARS),
          EXTRACTION.abstract,
        ),
      );
    } else {
      warnings.push(`《${labelOf(target, item)}》没有摘要，仅提供题录信息`);
    }
  }
  return { evidence, warnings };
}

/** 可选证据：已有批注与已存在的 PDF 全文缓存片段；只读，不索引、不 OCR、不下载。 */
export async function collectOptionalEvidence(
  targets: SelectionTarget[],
  options: EvidenceOptions = {},
): Promise<EvidenceResult> {
  const runtime = runtimeOf(options);
  const nextId = idSequence(options.startIndex);
  const warnings: string[] = [];
  const evidence: Evidence[] = [];
  const state = { apiWarned: false };
  for (const target of validTargets(targets, warnings)) {
    const item = await resolveItem(runtime, target, warnings);
    if (!item) {
      continue;
    }
    const title = titleOf(item, target);
    const label = labelOf(target, item);
    const ref = refOf(target);
    const attachments = item.isAttachment() ? [item] : childAttachments(runtime, item);
    let annotationCount = 0;
    let pdfCount = 0;
    for (const attachment of attachments) {
      for (const annotation of annotationsOf(attachment)) {
        const body = annotationBody(annotation);
        if (!body || typeof annotation.key !== "string") {
          continue;
        }
        evidence.push(
          makeEvidence(
            nextId(),
            { ...ref, attachmentKey: attachment.key, annotationKey: annotation.key },
            "annotation",
            title,
            clip(body, MAX_ANNOTATION_CHARS),
            EXTRACTION.annotation,
            { pageLabel: pageLabelOf(annotation) },
          ),
        );
        annotationCount += 1;
      }
      if (!isPDF(attachment)) {
        continue;
      }
      pdfCount += 1;
      const excerpt = await readCachedExcerpt(
        runtime,
        attachment,
        label,
        warnings,
        state,
      );
      if (excerpt) {
        evidence.push(
          makeEvidence(
            nextId(),
            { ...ref, attachmentKey: attachment.key },
            "pdf_excerpt",
            title,
            excerpt,
            EXTRACTION.fulltextCache,
            { start: excerpt.start, end: excerpt.end },
          ),
        );
      }
    }
    if (annotationCount === 0) {
      warnings.push(`《${label}》没有可用的批注`);
    }
    if (pdfCount === 0) {
      warnings.push(`《${label}》没有 PDF 附件，无法提供全文片段`);
    }
  }
  return { evidence, warnings };
}

/**
 * 只读跳转：题录/摘要证据选中条目，批注/全文证据在阅读器中打开附件。
 * 只依据本地校验过的 key 定位，不接受任何 URL。
 */
export async function openSource(
  evidence: Evidence,
  options: OpenSourceOptions = {},
): Promise<void> {
  const runtime = runtimeOf(options);
  if (!evidence || typeof evidence !== "object") {
    throw new ExplorerError("INVALID_SOURCE", "证据对象无效");
  }
  assertRef(evidence.libraryID, evidence.itemKey, "证据");
  if (evidence.attachmentKey !== undefined) {
    assertRef(evidence.libraryID, evidence.attachmentKey, "证据附件");
  }
  if (evidence.annotationKey !== undefined) {
    assertRef(evidence.libraryID, evidence.annotationKey, "证据批注");
  }

  let item: ZoteroItemLike | false;
  try {
    item = await runtime.Items.getByLibraryAndKeyAsync(
      evidence.libraryID,
      evidence.itemKey,
    );
  } catch {
    throw new ExplorerError("SOURCE_NOT_FOUND", "无法读取证据对应的文献");
  }
  if (!item || item.deleted === true) {
    throw new ExplorerError("SOURCE_NOT_FOUND", "证据对应的文献已不存在或已移入回收站");
  }

  const wantsReader =
    (evidence.kind === "annotation" || evidence.kind === "pdf_excerpt") &&
    evidence.attachmentKey !== undefined;
  if (wantsReader) {
    const attachmentKey = evidence.attachmentKey as string;
    let attachment: ZoteroItemLike | false;
    if (attachmentKey === item.key) {
      attachment = item;
    } else {
      try {
        attachment = await runtime.Items.getByLibraryAndKeyAsync(
          evidence.libraryID,
          attachmentKey,
        );
      } catch {
        attachment = false;
      }
    }
    if (!attachment || attachment.deleted === true || !attachment.isAttachment()) {
      throw new ExplorerError("SOURCE_NOT_FOUND", "证据对应的附件已不存在");
    }
    if (attachment !== item) {
      const parentKey = attachment.parentItemKey || attachment.parentItem?.key;
      if (parentKey !== item.key) {
        throw new ExplorerError("SOURCE_MISMATCH", "附件不属于证据所指的文献");
      }
    }
    if (typeof runtime.Reader?.open !== "function") {
      throw new ExplorerError("ZOTERO_UNAVAILABLE", "Zotero 阅读器不可用");
    }
    const location =
      evidence.annotationKey !== undefined
        ? { annotationKey: evidence.annotationKey }
        : undefined;
    await runtime.Reader.open(attachment.id, location, { allowDuplicate: false });
    return;
  }

  const pane =
    runtime.getActiveZoteroPane?.() ?? runtime.getMainWindow?.()?.ZoteroPane ?? null;
  if (typeof pane?.selectItem !== "function") {
    throw new ExplorerError("ZOTERO_UNAVAILABLE", "Zotero 主窗口不可用");
  }
  await pane.selectItem(item.id);
}
