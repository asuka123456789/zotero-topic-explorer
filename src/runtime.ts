import { ExplorerController } from "./agents/orchestrator.ts";
import { ExplorerError, newID, safeError } from "./domain/errors.ts";
import { hashText, utf8ByteLength } from "./domain/hash.ts";
import { validateEvidenceSet } from "./domain/schemas.ts";
import {
  DEFAULT_BUDGET,
  type Budget,
  type Evidence,
  type EvidenceResult,
  type ModelConfig,
  type Project,
  type ProviderSettings,
  type Role,
  type Run,
  type SelectionTarget,
  type Snapshot,
  type TopicCard,
} from "./domain/types.ts";
import {
  renderProjectMarkdown,
  renderRunDraftMarkdown,
  renderTopicCardMarkdown,
} from "./export/markdown.ts";
import { createTransport, validateModelConfig } from "./providers/openaiCompatible.ts";
import { SQLiteExplorerStore, type SQLiteConnection } from "./storage/sqliteStore.ts";
import { CredentialStore } from "./zotero/credentials.ts";
import {
  collectEvidence,
  collectOptionalEvidence,
  openSource,
} from "./zotero/evidence.ts";
import { collectSelection } from "./zotero/selection.ts";
import { getPref, setPref } from "./utils/prefs.ts";
import { logInternalError } from "./utils/common.ts";

export const ROLES: Role[] = ["explorer", "literature", "feasibility", "moderator"];

export const ROLE_LABELS: Record<Role, string> = {
  explorer: "探索",
  literature: "文献审查",
  feasibility: "可行性评估",
  moderator: "主控汇总",
};

export const DB_FILE = "zotero-topic-explorer.sqlite";
const MAX_MANUAL_CHARS = 8000;
const MAX_EVIDENCE_PER_PROJECT = 200;

export interface RunPreview {
  evidenceCount: number;
  evidenceBytes: number;
  truncatedCount: number;
  roles: Array<{ role: Role; config: ModelConfig }>;
  sharedNotes: string[];
  budget: Budget;
  warnings: string[];
}

export interface ImportPayload {
  targets: SelectionTarget[];
  result: EvidenceResult;
}

export type RuntimeEvent =
  { type: "run"; run: Run } | { type: "cards"; projectId: string };

type Listener = (event: RuntimeEvent) => void;

function evidenceKey(evidence: Evidence): string {
  return [
    evidence.kind,
    evidence.libraryID,
    evidence.itemKey,
    evidence.attachmentKey ?? "",
    evidence.annotationKey ?? "",
    evidence.hash,
  ].join("|");
}

function nextEvidenceIndex(existing: Evidence[]): number {
  let max = 0;
  for (const item of existing) {
    const match = /^E(\d+)$/.exec(item.id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export class ExplorerRuntime {
  readonly store: SQLiteExplorerStore;
  readonly controller: ExplorerController;
  readonly credentials: CredentialStore;
  private listeners = new Set<Listener>();
  private closed = false;

  private constructor(store: SQLiteExplorerStore, credentials: CredentialStore) {
    this.store = store;
    this.credentials = credentials;
    // CredentialStore 在密钥缺失时抛出 CREDENTIAL_MISSING，由传输层原样上抛。
    const transport = createTransport((configId) => this.credentials.get(configId));
    this.controller = new ExplorerController(store, transport, {
      onChange: (run) => this.emit({ type: "run", run }),
    });
  }

  static async create(): Promise<ExplorerRuntime> {
    const database = new Zotero.DBConnection(
      PathUtils.join(Zotero.DataDirectory.dir, DB_FILE),
    );
    // 参数可能包含论文文本；不让原生 SQL 调试日志输出参数。
    const queryOptions = { debug: false, noCache: false };
    const connection: SQLiteConnection = {
      queryAsync: (sql, params) =>
        (database.queryAsync as any)(sql, params, queryOptions),
      valueQueryAsync: (sql, params) =>
        (database.valueQueryAsync as any)(sql, params, queryOptions),
      executeTransaction: (operation) => database.executeTransaction(operation),
      closeDatabase: () => database.closeDatabase(true),
    };
    const store = new SQLiteExplorerStore(connection);
    try {
      await store.initialize();
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
    const runtime = new ExplorerRuntime(store, new CredentialStore());
    try {
      // 重启只把在途阶段标为结果未知，不自动重发。
      await runtime.controller.recover();
    } catch (error) {
      logInternalError("recover", error);
    }
    return runtime;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logInternalError("listener", error);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listeners.clear();
    await this.controller.shutdown();
    await this.store.close();
  }

  // ---- 模型配置（非敏感字段存偏好，密钥走 CredentialStore） ----

  getProviderSettings(): ProviderSettings {
    const empty: ProviderSettings = {
      models: [],
      bindings: { explorer: "", literature: "", feasibility: "", moderator: "" },
    };
    try {
      const parsed = JSON.parse(
        getPref("providers") || "{}",
      ) as Partial<ProviderSettings>;
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter(
            (model): model is ModelConfig =>
              !!model && typeof model === "object" && typeof model.id === "string",
          )
        : [];
      const bindings = { ...empty.bindings, ...(parsed.bindings ?? {}) };
      for (const role of ROLES) {
        if (!models.some((model) => model.id === bindings[role])) {
          bindings[role] = "";
        }
      }
      return { models, bindings };
    } catch {
      return empty;
    }
  }

  saveProviderSettings(settings: ProviderSettings): void {
    const ids = new Set<string>();
    for (const model of settings.models) {
      validateModelConfig(model);
      if (ids.has(model.id)) {
        throw new ExplorerError("DUPLICATE_MODEL_CONFIG", "模型配置 ID 重复");
      }
      ids.add(model.id);
    }
    for (const role of ROLES) {
      const bound = settings.bindings[role];
      if (bound && !ids.has(bound)) {
        throw new ExplorerError(
          "INVALID_BINDING",
          `${ROLE_LABELS[role]} 绑定了不存在的配置`,
        );
      }
    }
    setPref("providers", JSON.stringify(settings));
  }

  newModelConfig(): ModelConfig {
    return {
      id: newID("model"),
      label: "",
      baseURL: "",
      model: "",
      outputTokenField: "max_tokens",
      allowLocal: false,
    };
  }

  getBudget(): Budget {
    const maxRequests = Number(getPref("budget.maxRequests"));
    const maxOutputTokens = Number(getPref("budget.maxOutputTokens"));
    return {
      ...DEFAULT_BUDGET,
      maxRequests:
        Number.isFinite(maxRequests) && maxRequests > 0
          ? maxRequests
          : DEFAULT_BUDGET.maxRequests,
      maxOutputTokens:
        Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
          ? maxOutputTokens
          : DEFAULT_BUDGET.maxOutputTokens,
    };
  }

  saveBudget(budget: Pick<Budget, "maxRequests" | "maxOutputTokens">): void {
    setPref("budget.maxRequests", budget.maxRequests);
    setPref("budget.maxOutputTokens", budget.maxOutputTokens);
  }

  // ---- 项目 ----

  listProjects(): Promise<Project[]> {
    return this.store.listProjects();
  }

  getProject(id: string): Promise<Project | null> {
    return this.store.getProject(id);
  }

  async createProject(name: string): Promise<Project> {
    const now = Date.now();
    return this.store.saveProject({
      id: newID("project"),
      name: name.trim() || `选题探索 ${new Date(now).toLocaleString()}`,
      constraints: { interests: "", background: "", time: "", compute: "", data: "" },
      evidence: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveProject(project: Project): Promise<Project> {
    return this.store.saveProject(project, project.revision);
  }

  // ---- 材料（只读 Zotero） ----

  async collectFromMainWindow(
    mode: "items" | "collection",
    includeSubcollections = false,
  ): Promise<ImportPayload> {
    const win = Zotero.getMainWindow();
    const targets = await collectSelection(win as unknown as Window, {
      collection: mode === "collection",
      includeSubcollections,
    });
    if (targets.length === 0) {
      throw new ExplorerError("EMPTY_SELECTION", "主窗口没有选中可用的文献");
    }
    const result = await collectEvidence(targets);
    return { targets, result };
  }

  collectOptional(targets: SelectionTarget[]): Promise<EvidenceResult> {
    return collectOptionalEvidence(targets);
  }

  openSource(evidence: Evidence): Promise<void> {
    return openSource(evidence);
  }

  buildManualEvidence(target: SelectionTarget, text: string): Evidence {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new ExplorerError("EMPTY_EXCERPT", "手动摘录不能为空");
    }
    const truncated = trimmed.length > MAX_MANUAL_CHARS;
    const body = truncated ? trimmed.slice(0, MAX_MANUAL_CHARS) : trimmed;
    return {
      id: "E0",
      libraryID: target.libraryID,
      itemKey: target.itemKey,
      kind: "manual",
      title: target.title,
      text: body,
      hash: hashText(body),
      extraction: "manual",
      truncated,
    };
  }

  /** 合并证据到项目：跳过重复，新条目按 E{n} 编号，返回新增数。 */
  async addEvidence(
    project: Project,
    incoming: Evidence[],
  ): Promise<{ project: Project; added: number; skipped: number }> {
    const known = new Set(project.evidence.map(evidenceKey));
    let index = nextEvidenceIndex(project.evidence);
    const merged = [...project.evidence];
    let added = 0;
    let skipped = 0;
    for (const item of incoming) {
      const key = evidenceKey(item);
      if (known.has(key)) {
        skipped += 1;
        continue;
      }
      if (merged.length >= MAX_EVIDENCE_PER_PROJECT) {
        throw new ExplorerError(
          "EVIDENCE_LIMIT",
          `单个项目最多保留 ${MAX_EVIDENCE_PER_PROJECT} 条材料，请缩小选择`,
        );
      }
      known.add(key);
      merged.push({ ...item, id: `E${index}` });
      index += 1;
      added += 1;
    }
    const saved = await this.store.saveProject(
      { ...project, evidence: merged },
      project.revision,
    );
    return { project: saved, added, skipped };
  }

  async removeEvidence(project: Project, evidenceId: string): Promise<Project> {
    return this.store.saveProject(
      {
        ...project,
        evidence: project.evidence.filter((item) => item.id !== evidenceId),
      },
      project.revision,
    );
  }

  // ---- 讨论 ----

  private resolveModels(): Record<Role, ModelConfig> {
    const settings = this.getProviderSettings();
    const models = {} as Record<Role, ModelConfig>;
    for (const role of ROLES) {
      const config = settings.models.find(
        (model) => model.id === settings.bindings[role],
      );
      if (!config) {
        throw new ExplorerError(
          "ROLE_UNBOUND",
          `${ROLE_LABELS[role]} 尚未绑定模型配置，请先在设置中完成绑定`,
        );
      }
      validateModelConfig(config);
      models[role] = config;
    }
    return models;
  }

  /** 根据快照生成发送预览；不联网、不创建运行。 */
  previewSnapshot(snapshot: Snapshot): RunPreview {
    const { models, budget } = snapshot;
    const evidenceBytes = snapshot.evidence.reduce(
      (total, item) => total + utf8ByteLength(item.text),
      0,
    );
    const byConfig = new Map<string, Role[]>();
    for (const role of ROLES) {
      const list = byConfig.get(models[role].id) ?? [];
      list.push(role);
      byConfig.set(models[role].id, list);
    }
    const sharedNotes: string[] = [];
    for (const [, roles] of byConfig) {
      if (roles.length > 1) {
        sharedNotes.push(
          `${roles.map((role) => ROLE_LABELS[role]).join("、")} 使用同一模型配置，不是彼此独立的专家。`,
        );
      }
    }
    const warnings: string[] = [];
    if (evidenceBytes > budget.maxInputBytes * 0.8) {
      warnings.push(
        `材料约 ${evidenceBytes} 字节，接近或超过单次输入上限 ${budget.maxInputBytes} 字节；讨论可能在某一阶段因输入过大失败。`,
      );
    }
    return {
      evidenceCount: snapshot.evidence.length,
      evidenceBytes,
      truncatedCount: snapshot.evidence.filter((item) => item.truncated).length,
      roles: ROLES.map((role) => ({ role, config: models[role] })),
      sharedNotes,
      budget,
      warnings,
    };
  }

  async prepareRun(project: Project): Promise<{ run: Run; preview: RunPreview }> {
    if (project.evidence.length === 0) {
      throw new ExplorerError("NO_EVIDENCE", "请先添加至少一条材料");
    }
    validateEvidenceSet(project.evidence);
    const models = this.resolveModels();
    const budget = this.getBudget();
    const snapshot: Snapshot = {
      protocolVersion: 1,
      constraints: { ...project.constraints },
      evidence: project.evidence.map((item) => ({ ...item })),
      models,
      budget,
    };
    // 同一项目只保留一个待确认运行，避免旧预览被误启动。
    for (const stale of await this.store.listRuns(project.id)) {
      if (stale.state === "awaiting_confirmation") {
        await this.controller.cancel(stale.id);
      }
    }
    const run = await this.controller.prepare(project.id, snapshot);
    return { run, preview: this.previewSnapshot(run.snapshot) };
  }

  startRun(runId: string, fingerprint: string): Promise<void> {
    return this.controller.start(runId, fingerprint);
  }

  cancelRun(runId: string): Promise<void> {
    return this.controller.cancel(runId);
  }

  prepareRetry(
    runId: string,
    maxRequests: number | undefined,
    acknowledgeUnknown: boolean,
  ): Promise<Run> {
    return this.controller.prepareRetry(runId, maxRequests, acknowledgeUnknown);
  }

  listRuns(projectId: string): Promise<Run[]> {
    return this.store.listRuns(projectId);
  }

  getRun(id: string): Promise<Run | null> {
    return this.store.getRun(id);
  }

  // ---- 卡片 ----

  listCards(projectId: string): Promise<TopicCard[]> {
    return this.store.listCards(projectId);
  }

  async saveCard(card: TopicCard): Promise<TopicCard> {
    const saved = await this.store.saveCard(card, card.revision);
    this.emit({ type: "cards", projectId: card.projectId });
    return saved;
  }

  // ---- 导出 ----

  renderCard(card: TopicCard, run: Run | null, incomplete = false): string {
    return renderTopicCardMarkdown(card, run?.snapshot.evidence ?? [], {
      incomplete,
      includeGeneratedVersion: true,
    });
  }

  renderProject(project: Project, cards: TopicCard[]): string {
    return renderProjectMarkdown(project, cards);
  }

  renderRunDraft(run: Run, projectName: string): string {
    return renderRunDraftMarkdown(run, projectName);
  }

  async saveMarkdown(
    win: Window,
    suggestedName: string,
    content: string,
  ): Promise<string | null> {
    const picker = new ztoolkit.FilePicker(
      "导出 Markdown",
      "save",
      [["Markdown", "*.md"]],
      suggestedName,
      win,
    );
    const path = await picker.open();
    if (!path) {
      return null;
    }
    await Zotero.File.putContentsAsync(path, content);
    return path;
  }

  describeError(error: unknown): string {
    const safe = safeError(error);
    return `${safe.message}（${safe.code}）`;
  }
}
