import { config } from "../../package.json";
import { ExplorerError, safeError } from "../domain/errors.ts";
import {
  STEP_NAMES,
  type CardContent,
  type CardStatus,
  type Claim,
  type Evidence,
  type EvidenceResult,
  type ModelConfig,
  type Project,
  type ProviderSettings,
  type Run,
  type StepState,
  type TopicCard,
} from "../domain/types.ts";
import { RUN_STATE_LABELS, STEP_LABELS } from "../export/markdown.ts";
import {
  ROLES,
  ROLE_LABELS,
  type ExplorerRuntime,
  type ImportPayload,
  type RunPreview,
  type RuntimeEvent,
} from "../runtime.ts";
import { isWindowAlive, logInternalError } from "../utils/common.ts";
import { clear, field, formatTime, h, input, lines, select, textarea } from "./dom.ts";

const STEP_STATE_LABELS: Record<StepState, string> = {
  pending: "待开始",
  running: "请求中",
  received: "已收到，待校验",
  succeeded: "完成",
  failed: "失败",
  result_unknown: "结果未知",
  cancelled: "已取消",
};

const STATUS_LABELS: Record<CardStatus, string> = {
  exploring: "继续探索",
  experiment: "准备试验",
  paused: "暂缓",
  discarded: "放弃",
};

const KIND_LABELS: Record<Evidence["kind"], string> = {
  metadata: "书目",
  abstract: "摘要",
  annotation: "批注",
  pdf_excerpt: "PDF 缓存片段",
  manual: "手动摘录",
};

type View = "project" | "card" | "settings" | "import";

let current: Workbench | null = null;

export async function openWorkbench(
  runtime: ExplorerRuntime,
  payload?: ImportPayload,
): Promise<void> {
  if (current && isWindowAlive(current.win)) {
    current.win.focus();
    if (payload) {
      await current.receiveImport(payload);
    }
    return;
  }
  const mainWindow = Zotero.getMainWindow();
  const win = mainWindow.openDialog(
    `chrome://${config.addonRef}/content/workbench.xhtml`,
    `${config.addonRef}-workbench`,
    "chrome,centerscreen,resizable=yes,dialog=no,width=1240,height=780",
  );
  if (!win) {
    throw new ExplorerError("WINDOW_FAILED", "无法打开选题工作台窗口");
  }
  await new Promise<void>((resolve) => {
    if (
      win.document.readyState === "complete" &&
      win.location.href.includes("workbench.xhtml")
    ) {
      resolve();
      return;
    }
    win.addEventListener("load", () => resolve(), { once: true });
  });
  current = new Workbench(runtime, win);
  await current.init(payload);
}

export function closeWorkbench(): void {
  if (current && isWindowAlive(current.win)) {
    current.win.close();
  }
  current = null;
}

class Workbench {
  readonly win: Window;
  private readonly doc: Document;
  private readonly runtime: ExplorerRuntime;
  private projects: Project[] = [];
  private project: Project | null = null;
  private cards: TopicCard[] = [];
  private runs: Run[] = [];
  private run: Run | null = null;
  private selectedCardId: string | null = null;
  private view: View = "project";
  private pendingImport: ImportPayload | null = null;
  private optional: EvidenceResult | null = null;
  private optionalSelected = new Set<number>();
  private pendingRun: { run: Run; preview: RunPreview } | null = null;
  private busy = false;
  private notice: { text: string; level: "info" | "error" | "warn" | "ok" } | null =
    null;
  private unsubscribe: () => void = () => {};
  private toolbarEl!: HTMLElement;
  private leftEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private rightEl!: HTMLElement;
  private runPanelEl: HTMLElement | null = null;

  constructor(runtime: ExplorerRuntime, win: Window) {
    this.runtime = runtime;
    this.win = win;
    this.doc = win.document;
  }

  async init(payload?: ImportPayload): Promise<void> {
    const root = this.doc.getElementById("app");
    if (!root) {
      throw new ExplorerError("WINDOW_FAILED", "工作台页面缺少挂载点");
    }
    root.classList.remove("loading");
    clear(root);
    this.toolbarEl = h(this.doc, "div", { className: "toolbar" });
    this.leftEl = h(this.doc, "div", { className: "column" });
    this.mainEl = h(this.doc, "div", { className: "column" });
    this.rightEl = h(this.doc, "div", { className: "column" });
    root.append(
      this.toolbarEl,
      h(this.doc, "div", { className: "columns" }, [
        this.leftEl,
        this.mainEl,
        this.rightEl,
      ]),
    );
    this.unsubscribe = this.runtime.subscribe((event) => this.onEvent(event));
    this.win.addEventListener(
      "unload",
      () => {
        this.unsubscribe();
        if (current === this) {
          current = null;
        }
      },
      { once: true },
    );
    await this.reloadProjects();
    if (this.projects.length > 0) {
      await this.selectProject(this.projects[0].id);
    }
    if (payload) {
      await this.receiveImport(payload);
    } else {
      this.renderAll();
    }
  }

  async receiveImport(payload: ImportPayload): Promise<void> {
    this.pendingImport = payload;
    this.optional = null;
    this.optionalSelected.clear();
    this.view = "import";
    this.setNotice(
      `已读取 ${payload.targets.length} 篇文献的书目与摘要；尚未发送任何内容。`,
      "info",
    );
    this.renderAll();
  }

  // ---- 数据装载 ----

  private async reloadProjects(): Promise<void> {
    this.projects = await this.runtime.listProjects();
  }

  private async selectProject(id: string | null): Promise<void> {
    this.project = id ? await this.runtime.getProject(id) : null;
    this.pendingRun = null;
    this.selectedCardId = null;
    if (this.project) {
      this.cards = await this.runtime.listCards(this.project.id);
      this.runs = await this.runtime.listRuns(this.project.id);
      this.run = this.runs[0] ?? null;
      const awaiting = this.runs.find((run) => run.state === "awaiting_confirmation");
      if (awaiting) {
        // 重启后遗留的待确认运行不能被静默启动；提示用户重新生成预览。
        await this.runtime.cancelRun(awaiting.id);
        this.runs = await this.runtime.listRuns(this.project.id);
        this.run = this.runs[0] ?? null;
      }
    } else {
      this.cards = [];
      this.runs = [];
      this.run = null;
    }
    if (this.view === "card") {
      this.view = "project";
    }
  }

  private async refreshProject(): Promise<void> {
    if (!this.project) {
      return;
    }
    this.project = await this.runtime.getProject(this.project.id);
    this.cards = this.project ? await this.runtime.listCards(this.project.id) : [];
    this.runs = this.project ? await this.runtime.listRuns(this.project.id) : [];
    if (this.run) {
      this.run =
        this.runs.find((run) => run.id === this.run!.id) ?? this.runs[0] ?? null;
    } else {
      this.run = this.runs[0] ?? null;
    }
    await this.reloadProjects();
  }

  private onEvent(event: RuntimeEvent): void {
    if (!this.project) {
      return;
    }
    if (event.type === "run" && event.run.projectId === this.project.id) {
      const index = this.runs.findIndex((run) => run.id === event.run.id);
      if (index >= 0) {
        this.runs[index] = event.run;
      } else {
        this.runs.unshift(event.run);
      }
      if (!this.run || this.run.id === event.run.id) {
        this.run = event.run;
      }
      if (this.pendingRun && this.pendingRun.run.id === event.run.id) {
        this.pendingRun = { ...this.pendingRun, run: event.run };
      }
      this.renderRunPanel();
      if (event.run.state === "completed") {
        void this.runtime.listCards(this.project.id).then((cards) => {
          this.cards = cards;
          this.renderLeft();
          this.renderRight();
        });
      }
      this.renderRight();
    } else if (event.type === "cards" && event.projectId === this.project.id) {
      void this.runtime.listCards(this.project.id).then((cards) => {
        this.cards = cards;
        this.renderLeft();
        this.renderRight();
      });
    }
  }

  // ---- 通用 ----

  private setNotice(text: string, level: "info" | "error" | "warn" | "ok"): void {
    this.notice = { text, level };
    this.renderToolbar();
  }

  private fail(error: unknown): void {
    const safe = safeError(error);
    this.setNotice(`${safe.message}（${safe.code}）`, "error");
    if (safe.code === "INTERNAL_ERROR") {
      logInternalError("workbench", error);
    }
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await action();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  private evidenceById(id: string): Evidence | undefined {
    return (
      this.run?.snapshot.evidence.find((item) => item.id === id) ??
      this.project?.evidence.find((item) => item.id === id)
    );
  }

  private renderAll(): void {
    this.renderToolbar();
    this.renderLeft();
    this.renderMain();
    this.renderRight();
  }

  // ---- 工具栏 ----

  private renderToolbar(): void {
    const doc = this.doc;
    clear(this.toolbarEl);
    this.toolbarEl.append(
      h(doc, "strong", {}, ["选题探索"]),
      h(doc, "span", { className: "muted" }, [
        this.project ? this.project.name : "尚未选择项目",
      ]),
      h(doc, "span", { className: "spacer" }),
      h(
        doc,
        "button",
        {
          onClick: () =>
            void this.guard(async () => {
              const payload = await this.runtime.collectFromMainWindow("items");
              await this.receiveImport(payload);
            }),
        },
        ["导入主窗口所选文献"],
      ),
      h(
        doc,
        "button",
        {
          onClick: () => {
            this.view = this.view === "settings" ? "project" : "settings";
            this.renderMain();
          },
        },
        [this.view === "settings" ? "返回项目" : "设置"],
      ),
      h(
        doc,
        "button",
        {
          disabled: !this.project,
          onClick: () =>
            void this.guard(async () => {
              if (!this.project) {
                return;
              }
              const path = await this.runtime.saveMarkdown(
                this.win,
                `${this.project.name}.md`,
                this.runtime.renderProject(this.project, this.cards),
              );
              if (path) {
                this.setNotice(`已导出：${path}`, "ok");
              }
            }),
        },
        ["导出项目 Markdown"],
      ),
    );
    if (this.notice) {
      this.toolbarEl.append(
        h(
          doc,
          "div",
          {
            className: `notice ${this.notice.level}`,
            style: "flex-basis:100%;margin:6px 0 0",
          },
          [this.notice.text],
        ),
      );
    }
  }

  // ---- 左栏：项目与卡片 ----

  private renderLeft(): void {
    const doc = this.doc;
    clear(this.leftEl);
    const nameInput = input(doc, "text", "", { placeholder: "新项目名称" });
    this.leftEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["探索项目"]),
        h(doc, "div", { className: "row" }, [
          nameInput,
          h(
            doc,
            "button",
            {
              onClick: () =>
                void this.guard(async () => {
                  const project = await this.runtime.createProject(nameInput.value);
                  await this.reloadProjects();
                  await this.selectProject(project.id);
                  this.view = "project";
                  this.renderAll();
                }),
            },
            ["新建"],
          ),
        ]),
        h(
          doc,
          "ul",
          { className: "list" },
          this.projects.map((project) =>
            h(
              doc,
              "li",
              {
                className: this.project?.id === project.id ? "active" : "",
                onClick: () =>
                  void this.guard(async () => {
                    await this.selectProject(project.id);
                    this.view = "project";
                    this.renderAll();
                  }),
              },
              [
                project.name,
                h(doc, "span", { className: "meta" }, [
                  `${project.evidence.length} 条材料 · ${formatTime(project.updatedAt)}`,
                ]),
              ],
            ),
          ),
        ),
      ]),
    );
    if (this.project) {
      const rename = h(
        doc,
        "button",
        {
          onClick: () =>
            void this.guard(async () => {
              if (!this.project) {
                return;
              }
              const name = this.win.prompt("项目名称", this.project.name);
              if (name && name.trim()) {
                this.project = await this.runtime.saveProject({
                  ...this.project,
                  name: name.trim(),
                });
                await this.reloadProjects();
                this.renderAll();
              }
            }),
        },
        ["重命名项目"],
      );
      this.leftEl.append(
        h(doc, "div", { className: "section" }, [
          h(doc, "h2", {}, ["选题卡片"]),
          this.cards.length === 0
            ? h(doc, "div", { className: "muted" }, ["完成一轮讨论后会生成卡片。"])
            : h(
                doc,
                "ul",
                { className: "list" },
                this.cards.map((card) => {
                  const content = card.edited ?? card.generated;
                  return h(
                    doc,
                    "li",
                    {
                      className:
                        this.view === "card" && this.selectedCardId === card.id
                          ? "active"
                          : "",
                      onClick: () => {
                        this.selectedCardId = card.id;
                        this.view = "card";
                        this.renderMain();
                        this.renderLeft();
                      },
                    },
                    [
                      content.title,
                      h(doc, "span", { className: "meta" }, [
                        `${STATUS_LABELS[card.status]}${card.needsReview ? " · 待复核" : ""} · 第 ${card.revision} 版`,
                      ]),
                    ],
                  );
                }),
              ),
          h(doc, "div", { className: "row" }, [rename]),
        ]),
      );
    }
  }

  // ---- 中栏 ----

  private renderMain(): void {
    clear(this.mainEl);
    this.runPanelEl = null;
    switch (this.view) {
      case "settings":
        this.renderSettings();
        break;
      case "import":
        this.renderImport();
        break;
      case "card":
        this.renderCard();
        break;
      default:
        this.renderProjectView();
    }
    this.renderToolbar();
  }

  private renderProjectView(): void {
    const doc = this.doc;
    if (!this.project) {
      this.mainEl.append(
        h(doc, "div", { className: "notice" }, [
          "先在左侧新建项目，或在 Zotero 主窗口右键文献选择“探索选题”。",
        ]),
      );
      return;
    }
    const project = this.project;
    const constraints = { ...project.constraints };
    const fields: Array<[keyof typeof constraints, string, string]> = [
      ["interests", "研究兴趣", "想解决什么问题、对哪些方向有兴趣；不确定可写“未知”"],
      ["background", "已有基础", "已掌握的方法、代码或数据经验"],
      ["time", "可用时间", "例如：每周 15 小时，持续 4 个月"],
      ["compute", "算力条件", "例如：单卡 24GB；或“未知”"],
      ["data", "数据条件", "可直接使用的数据集或获取途径"],
    ];
    const form = h(doc, "div", { className: "section" }, [
      h(doc, "h2", {}, ["研究约束"]),
      h(doc, "div", { className: "muted" }, [
        "缺失的条件请填“未知”，讨论不会替你假设。",
      ]),
    ]);
    for (const [key, label, placeholder] of fields) {
      const area = textarea(doc, constraints[key], { placeholder });
      area.addEventListener("input", () => {
        constraints[key] = area.value;
      });
      form.append(field(doc, label, area));
    }
    form.append(
      h(doc, "div", { className: "row" }, [
        h(
          doc,
          "button",
          {
            onClick: () =>
              void this.guard(async () => {
                this.project = await this.runtime.saveProject({
                  ...project,
                  constraints: { ...constraints },
                });
                await this.reloadProjects();
                this.setNotice("研究约束已保存。", "ok");
                this.renderLeft();
              }),
          },
          ["保存约束"],
        ),
      ]),
    );
    this.mainEl.append(form);
    this.runPanelEl = h(doc, "div", { className: "section" });
    this.mainEl.append(this.runPanelEl);
    this.renderRunPanel();
  }

  private renderRunPanel(): void {
    if (!this.runPanelEl || this.view !== "project" || !this.project) {
      return;
    }
    const doc = this.doc;
    const panel = this.runPanelEl;
    clear(panel);
    panel.append(h(doc, "h2", {}, ["多 Agent 讨论"]));

    if (this.pendingRun) {
      panel.append(this.renderPreview(this.pendingRun));
      return;
    }

    const run = this.run;
    const active = run?.state === "running";
    const controls = h(doc, "div", { className: "row" });
    if (active && run) {
      controls.append(
        h(
          doc,
          "button",
          {
            className: "danger",
            onClick: () => void this.guard(() => this.runtime.cancelRun(run.id)),
          },
          ["停止讨论"],
        ),
        h(doc, "span", { className: "muted" }, [
          "停止后不再发送新请求；已提交的请求仍可能产生费用。",
        ]),
      );
    } else {
      controls.append(
        h(
          doc,
          "button",
          {
            className: "primary",
            onClick: () =>
              void this.guard(async () => {
                if (!this.project) {
                  return;
                }
                this.pendingRun = await this.runtime.prepareRun(this.project);
                this.runs = await this.runtime.listRuns(this.project.id);
                this.run = this.pendingRun.run;
                this.renderRunPanel();
                this.renderRight();
              }),
          },
          ["生成发送预览"],
        ),
        h(doc, "span", { className: "muted" }, [
          "生成预览不会联网；只有点击“确认发送并讨论”后才请求模型。",
        ]),
      );
    }
    panel.append(controls);

    if (!run) {
      return;
    }
    panel.append(this.renderRunStatus(run));

    if (["failed", "interrupted", "cancelled"].includes(run.state)) {
      const hasUnknown = run.steps.some((step) => step.state === "result_unknown");
      const exhausted = run.requestsUsed >= run.snapshot.budget.maxRequests;
      const ack = input(doc, "checkbox", "");
      const requestsInput = input(
        doc,
        "number",
        String(
          exhausted
            ? run.snapshot.budget.maxRequests + 3
            : run.snapshot.budget.maxRequests,
        ),
        { min: "1", max: "12", style: "width:80px" },
      );
      const retryRow = h(doc, "div", { className: "row" }, [
        h(doc, "span", {}, ["请求上限"]),
        requestsInput,
      ]);
      if (hasUnknown) {
        retryRow.append(
          h(doc, "label", {}, [
            ack,
            " 我知道结果未知的阶段可能已被上游计费，重试会再次计费",
          ]),
        );
      }
      retryRow.append(
        h(
          doc,
          "button",
          {
            onClick: () =>
              void this.guard(async () => {
                if (!this.project) {
                  return;
                }
                const maxRequests = Number(requestsInput.value);
                const retried = await this.runtime.prepareRetry(
                  run.id,
                  Number.isFinite(maxRequests) ? maxRequests : undefined,
                  ack.checked,
                );
                this.runs = await this.runtime.listRuns(this.project.id);
                this.run = retried;
                this.pendingRun = {
                  run: retried,
                  preview: this.runtime.previewSnapshot(retried.snapshot),
                };
                this.renderRunPanel();
                this.renderRight();
              }),
          },
          ["准备重试未完成阶段"],
        ),
        h(
          doc,
          "button",
          {
            onClick: () =>
              void this.guard(async () => {
                if (!this.project) {
                  return;
                }
                const path = await this.runtime.saveMarkdown(
                  this.win,
                  `${this.project.name}-讨论草稿-不完整.md`,
                  this.runtime.renderRunDraft(run, this.project.name),
                );
                if (path) {
                  this.setNotice(`已导出不完整草稿：${path}`, "ok");
                }
              }),
          },
          ["导出不完整草稿"],
        ),
      );
      panel.append(retryRow);
    }
    panel.append(this.renderRunOutputs(run));
  }

  private renderPreview(pending: { run: Run; preview: RunPreview }): HTMLElement {
    const doc = this.doc;
    const { run, preview } = pending;
    const table = h(doc, "table", { className: "summary" }, [
      h(doc, "tr", {}, [
        h(doc, "th", {}, ["角色"]),
        h(doc, "th", {}, ["配置"]),
        h(doc, "th", {}, ["服务地址"]),
        h(doc, "th", {}, ["模型"]),
      ]),
      ...preview.roles.map(({ role, config: model }) =>
        h(doc, "tr", {}, [
          h(doc, "td", {}, [ROLE_LABELS[role]]),
          h(doc, "td", {}, [model.label || model.id]),
          h(doc, "td", {}, [model.baseURL]),
          h(doc, "td", {}, [model.model]),
        ]),
      ),
    ]);
    const confirmButton = h(
      doc,
      "button",
      {
        className: "primary",
        onClick: () => {
          if (confirmButton.hasAttribute("disabled")) {
            return;
          }
          confirmButton.setAttribute("disabled", "");
          void this.guard(async () => {
            const target = this.pendingRun;
            if (!target || target.run.id !== run.id) {
              return;
            }
            this.pendingRun = null;
            this.run = target.run;
            this.renderRunPanel();
            await this.runtime.startRun(target.run.id, target.run.fingerprint);
          });
        },
      },
      ["确认发送并讨论"],
    ) as HTMLButtonElement;
    return h(doc, "div", {}, [
      h(doc, "div", { className: "notice warn" }, [
        `将把 ${preview.evidenceCount} 条材料（约 ${preview.evidenceBytes} 字节${preview.truncatedCount ? `，其中 ${preview.truncatedCount} 条已截断` : ""}）和研究约束发送给下表服务；中间评审结果会在这些服务之间传递。最多 ${preview.budget.maxRequests} 次请求，每次输出上限 ${preview.budget.maxOutputTokens} tokens，总时限 ${Math.round(preview.budget.maxDurationMs / 60000)} 分钟。费用取决于各服务计价，插件不能保证金额上限。`,
      ]),
      table,
      ...preview.sharedNotes.map((note) =>
        h(doc, "div", { className: "notice" }, [note]),
      ),
      ...preview.warnings.map((note) =>
        h(doc, "div", { className: "notice warn" }, [note]),
      ),
      h(doc, "div", { className: "muted" }, [
        `快照指纹：${run.fingerprint.slice(0, 16)}…`,
      ]),
      h(doc, "div", { className: "row" }, [
        confirmButton,
        h(
          doc,
          "button",
          {
            onClick: () =>
              void this.guard(async () => {
                await this.runtime.cancelRun(run.id);
                this.pendingRun = null;
                this.runs = this.project
                  ? await this.runtime.listRuns(this.project.id)
                  : [];
                this.run = this.runs.find((item) => item.id !== run.id) ?? null;
                this.renderRunPanel();
                this.renderRight();
              }),
          },
          ["放弃本次预览"],
        ),
      ]),
    ]);
  }

  private renderRunStatus(run: Run): HTMLElement {
    const doc = this.doc;
    let inputTokens = 0;
    let outputTokens = 0;
    let unknownUsage = false;
    for (const step of run.steps) {
      for (const attempt of step.attempts) {
        if (!attempt.usage) {
          continue;
        }
        if (attempt.usage.inputTokens === null || attempt.usage.outputTokens === null) {
          unknownUsage = true;
        } else {
          inputTokens += attempt.usage.inputTokens;
          outputTokens += attempt.usage.outputTokens;
        }
      }
    }
    const grid = h(doc, "div", { className: "steps" });
    for (const step of run.steps) {
      const last = step.attempts[step.attempts.length - 1];
      grid.append(
        h(doc, "span", {}, [STEP_LABELS[step.name]]),
        h(doc, "span", { className: `state-${step.state}` }, [
          `${STEP_STATE_LABELS[step.state]}${last?.error ? `：${last.error.message}` : ""}`,
        ]),
      );
    }
    const children: Array<HTMLElement | string> = [
      h(doc, "div", { className: "muted" }, [
        `状态：${RUN_STATE_LABELS[run.state]} · 已发送 ${run.requestsUsed}/${run.snapshot.budget.maxRequests} 次 · 用量：输入 ${inputTokens}${unknownUsage ? "+未知" : ""} / 输出 ${outputTokens}${unknownUsage ? "+未知" : ""} tokens（以服务端 usage 为准）`,
      ]),
      grid,
    ];
    if (run.error) {
      children.push(
        h(doc, "div", { className: "notice error" }, [
          `${run.error.message}（${run.error.code}）`,
        ]),
      );
    }
    return h(doc, "div", {}, children);
  }

  private renderClaims(claims: Claim[]): HTMLElement {
    const doc = this.doc;
    const container = h(doc, "div", {});
    if (claims.length === 0) {
      container.append(h(doc, "div", { className: "muted" }, ["无论断"]));
      return container;
    }
    for (const claim of claims) {
      const block = h(doc, "div", { className: "claim" }, [
        h(doc, "span", { className: "tag" }, [claim.kind]),
        claim.text,
      ]);
      for (const citation of claim.citations) {
        const evidence = this.evidenceById(citation.evidenceId);
        const quote = h(doc, "span", { className: "quote" }, [
          `[${citation.evidenceId}] “${citation.quote}”`,
        ]);
        if (evidence) {
          quote.append(
            " ",
            h(
              doc,
              "button",
              {
                style: "padding:0 6px;font-size:11px",
                onClick: () => void this.guard(() => this.runtime.openSource(evidence)),
              },
              ["来源"],
            ),
          );
        } else {
          quote.append(" （证据已不在项目中）");
        }
        block.append(quote);
      }
      container.append(block);
    }
    return container;
  }

  private renderRunOutputs(run: Run): HTMLElement {
    const doc = this.doc;
    const container = h(doc, "div", {});
    for (const name of STEP_NAMES) {
      const step = run.steps.find((item) => item.name === name);
      const output = step?.output;
      if (!output) {
        continue;
      }
      const details = h(doc, "details", {}, [
        h(doc, "summary", {}, [STEP_LABELS[name]]),
      ]);
      if ("candidates" in output) {
        for (const candidate of output.candidates) {
          details.append(
            h(doc, "h3", {}, [`${candidate.id}：${candidate.title}`]),
            h(doc, "div", {}, [`研究问题：${candidate.question}`]),
            h(doc, "div", { className: "muted" }, [candidate.rationale]),
            this.renderClaims(candidate.claims),
          );
        }
      } else if ("reviews" in output) {
        for (const review of output.reviews) {
          details.append(
            h(doc, "h3", {}, [`候选题 ${review.candidateId}`]),
            h(doc, "div", {}, [review.assessment]),
            h(doc, "div", { className: "muted" }, [
              `异议：${review.objections.join("；") || "无"}`,
            ]),
            h(doc, "div", { className: "muted" }, [
              `待检索问题：${review.unknowns.join("；") || "无"}`,
            ]),
            this.renderClaims(review.claims),
          );
        }
      } else {
        details.append(
          h(doc, "div", { className: "muted" }, [
            `已生成 ${output.cards.length} 张选题卡片，见左侧列表。`,
          ]),
        );
      }
      container.append(details);
    }
    return container;
  }

  // ---- 卡片 ----

  private renderCard(): void {
    const doc = this.doc;
    const card = this.cards.find((item) => item.id === this.selectedCardId);
    if (!card || !this.project) {
      this.view = "project";
      this.renderProjectView();
      return;
    }
    const draft: CardContent = JSON.parse(
      JSON.stringify(card.edited ?? card.generated),
    ) as CardContent;
    let contentChanged = false;
    let status: CardStatus = card.status;
    let notes = card.notes;
    const bind = (key: keyof CardContent, label: string, multiline = true) => {
      const value = draft[key];
      if (Array.isArray(value)) {
        const area = textarea(doc, value.join("\n"), { placeholder: "每行一条" });
        area.addEventListener("input", () => {
          (draft[key] as string[]) = lines(area.value);
          contentChanged = true;
        });
        return field(doc, `${label}（每行一条）`, area);
      }
      const element = multiline
        ? textarea(doc, String(value))
        : input(doc, "text", String(value));
      element.addEventListener("input", () => {
        (draft[key] as string) = element.value;
        contentChanged = true;
      });
      return field(doc, label, element);
    };
    const statusSelect = select(
      doc,
      (Object.keys(STATUS_LABELS) as CardStatus[]).map((value) => ({
        value,
        label: STATUS_LABELS[value],
      })),
      status,
    );
    statusSelect.addEventListener("change", () => {
      status = statusSelect.value as CardStatus;
    });
    const notesArea = textarea(doc, notes, {
      placeholder: "你的判断、理由与备注；AI 重新分析不会覆盖这里",
    });
    notesArea.addEventListener("input", () => {
      notes = notesArea.value;
    });
    const sourceRun = this.runs.find((item) => item.id === card.runId) ?? null;
    const saveCard = async (markReviewed: boolean) => {
      const next: TopicCard = {
        ...card,
        edited: contentChanged || card.edited ? draft : undefined,
        status,
        notes,
        needsReview: markReviewed ? false : card.needsReview || contentChanged,
      };
      await this.runtime.saveCard(next);
      await this.refreshProject();
      this.setNotice("卡片已保存。", "ok");
      this.renderAll();
    };
    this.mainEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, [`选题卡片：${(card.edited ?? card.generated).title}`]),
        h(doc, "div", { className: "muted" }, [
          `候选题 ${card.generated.candidateId} · 第 ${card.revision} 版 · 来自讨论 ${formatTime(card.createdAt)}${card.needsReview ? " · 待复核" : ""}`,
        ]),
        h(doc, "div", { className: "notice" }, [
          "仅基于所选资料，未完成全网查新。引用可追溯不代表论证成立；修改内容后卡片会标为待复核。",
        ]),
        bind("title", "标题", false),
        bind("question", "研究问题"),
        bind("motivation", "动机"),
        h(doc, "h3", {}, ["证据与论断（AI 生成，只读）"]),
        this.renderClaims(card.generated.claims),
        bind("differences", "与已有工作的区别"),
        bind("resources", "资源要求"),
        bind("minimumExperiment", "最小验证实验"),
        bind("stopConditions", "停止条件"),
        bind("disagreements", "未解决分歧"),
        bind("nextSteps", "下一步"),
        field(doc, "人工状态", statusSelect),
        field(doc, "用户备注", notesArea),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              className: "primary",
              onClick: () => void this.guard(() => saveCard(false)),
            },
            ["保存卡片"],
          ),
          h(doc, "button", { onClick: () => void this.guard(() => saveCard(true)) }, [
            "保存并标记已复核",
          ]),
          h(
            doc,
            "button",
            {
              onClick: () =>
                void this.guard(async () => {
                  const path = await this.runtime.saveMarkdown(
                    this.win,
                    `${(card.edited ?? card.generated).title}.md`,
                    this.runtime.renderCard(
                      card,
                      sourceRun,
                      sourceRun ? sourceRun.state !== "completed" : false,
                    ),
                  );
                  if (path) {
                    this.setNotice(`已导出：${path}`, "ok");
                  }
                }),
            },
            ["导出此卡片"],
          ),
          h(
            doc,
            "button",
            {
              onClick: () => {
                this.view = "project";
                this.renderMain();
                this.renderLeft();
              },
            },
            ["返回"],
          ),
        ]),
        card.edited
          ? h(doc, "details", {}, [
              h(doc, "summary", {}, ["查看 AI 原始版本"]),
              h(doc, "div", {}, [`标题：${card.generated.title}`]),
              h(doc, "div", {}, [`研究问题：${card.generated.question}`]),
              h(doc, "div", {}, [`动机：${card.generated.motivation}`]),
              h(doc, "div", {}, [`区别：${card.generated.differences}`]),
              h(doc, "div", {}, [`资源：${card.generated.resources}`]),
              h(doc, "div", {}, [`最小实验：${card.generated.minimumExperiment}`]),
            ])
          : null,
      ]),
    );
  }

  // ---- 导入材料 ----

  private renderImport(): void {
    const doc = this.doc;
    const payload = this.pendingImport;
    if (!payload) {
      this.view = "project";
      this.renderProjectView();
      return;
    }
    const projectOptions = [
      ...this.projects.map((project) => ({ value: project.id, label: project.name })),
      { value: "", label: "新建项目…" },
    ];
    const projectSelect = select(doc, projectOptions, this.project?.id ?? "");
    const newName = input(doc, "text", "", { placeholder: "新项目名称" });
    const manualTarget = select(
      doc,
      payload.targets.map((target) => ({
        value: `${target.libraryID}:${target.itemKey}`,
        label: target.title,
      })),
      `${payload.targets[0].libraryID}:${payload.targets[0].itemKey}`,
    );
    const manualText = textarea(doc, "", {
      placeholder: "从论文中手动摘录的原文（会作为可引用证据发送）",
    });
    const manualList: Evidence[] = [];
    const manualListEl = h(doc, "div", {});
    const optionalEl = h(doc, "div", {});
    const renderOptional = () => {
      clear(optionalEl);
      if (!this.optional) {
        return;
      }
      for (const warning of this.optional.warnings) {
        optionalEl.append(h(doc, "div", { className: "notice warn" }, [warning]));
      }
      if (this.optional.evidence.length === 0) {
        optionalEl.append(
          h(doc, "div", { className: "muted" }, ["没有可用的批注或已有全文缓存片段。"]),
        );
      }
      this.optional.evidence.forEach((item, index) => {
        const box = input(doc, "checkbox", "");
        box.checked = this.optionalSelected.has(index);
        box.addEventListener("change", () => {
          if (box.checked) {
            this.optionalSelected.add(index);
          } else {
            this.optionalSelected.delete(index);
          }
        });
        optionalEl.append(
          h(doc, "div", { className: "evidence" }, [
            h(doc, "label", {}, [box, " ", this.evidenceHeader(item)]),
            h(doc, "div", { className: "text" }, [item.text]),
          ]),
        );
      });
    };
    const addAll = async () => {
      let project = this.project;
      const selectedId = projectSelect.value;
      if (!selectedId) {
        project = await this.runtime.createProject(newName.value);
      } else if (!project || project.id !== selectedId) {
        project = await this.runtime.getProject(selectedId);
      }
      if (!project) {
        throw new ExplorerError("PROJECT_NOT_FOUND", "目标项目不存在");
      }
      const incoming: Evidence[] = [
        ...payload.result.evidence,
        ...(this.optional?.evidence.filter((_, index) =>
          this.optionalSelected.has(index),
        ) ?? []),
        ...manualList,
      ];
      const {
        project: saved,
        added,
        skipped,
      } = await this.runtime.addEvidence(project, incoming);
      this.pendingImport = null;
      this.optional = null;
      this.optionalSelected.clear();
      await this.reloadProjects();
      await this.selectProject(saved.id);
      this.view = "project";
      this.setNotice(
        `已加入 ${added} 条材料${skipped ? `，跳过 ${skipped} 条重复` : ""}。`,
        "ok",
      );
      this.renderAll();
    };
    this.mainEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, [`导入材料（${payload.targets.length} 篇文献）`]),
        h(doc, "div", { className: "notice" }, [
          "默认只读取书目信息和摘要；不会自动提取 PDF、OCR 或下载附件。以下内容尚未发送给任何模型。",
        ]),
        ...payload.result.warnings.map((warning) =>
          h(doc, "div", { className: "notice warn" }, [warning]),
        ),
        ...payload.result.evidence.map((item) =>
          h(doc, "div", { className: "evidence" }, [
            this.evidenceHeader(item),
            h(doc, "div", { className: "text" }, [item.text]),
          ]),
        ),
      ]),
      h(doc, "div", { className: "section" }, [
        h(doc, "h3", {}, ["可选：批注与已有 PDF 缓存片段"]),
        h(doc, "div", { className: "muted" }, [
          "只读取 Zotero 已存在的批注和全文缓存；缓存没有分页信息时只给出字符范围，不会编造页码。",
        ]),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              onClick: () =>
                void this.guard(async () => {
                  this.optional = await this.runtime.collectOptional(payload.targets);
                  this.optionalSelected.clear();
                  renderOptional();
                }),
            },
            ["读取可选材料"],
          ),
        ]),
        optionalEl,
      ]),
      h(doc, "div", { className: "section" }, [
        h(doc, "h3", {}, ["可选：手动摘录"]),
        field(doc, "所属文献", manualTarget),
        field(doc, "原文摘录", manualText),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              onClick: () =>
                void this.guard(async () => {
                  const target = payload.targets.find(
                    (item) =>
                      `${item.libraryID}:${item.itemKey}` === manualTarget.value,
                  );
                  if (!target) {
                    return;
                  }
                  const evidence = this.runtime.buildManualEvidence(
                    target,
                    manualText.value,
                  );
                  manualList.push(evidence);
                  manualText.value = "";
                  manualListEl.append(
                    h(doc, "div", { className: "evidence" }, [
                      this.evidenceHeader(evidence),
                      h(doc, "div", { className: "text" }, [evidence.text]),
                    ]),
                  );
                }),
            },
            ["添加摘录"],
          ),
        ]),
        manualListEl,
      ]),
      h(doc, "div", { className: "section" }, [
        field(doc, "目标项目", projectSelect),
        field(doc, "新项目名称（选择“新建项目…”时使用）", newName),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            { className: "primary", onClick: () => void this.guard(addAll) },
            ["加入项目"],
          ),
          h(
            doc,
            "button",
            {
              onClick: () => {
                this.pendingImport = null;
                this.optional = null;
                this.view = "project";
                this.renderAll();
              },
            },
            ["放弃导入"],
          ),
        ]),
      ]),
    );
  }

  private evidenceHeader(item: Evidence): HTMLElement {
    const doc = this.doc;
    const locator = item.pageLabel
      ? `页码/位置 ${item.pageLabel}`
      : item.start !== undefined && item.end !== undefined
        ? `字符 ${item.start}–${item.end}`
        : "";
    return h(doc, "div", { className: "title" }, [
      h(doc, "span", { className: "tag" }, [KIND_LABELS[item.kind]]),
      item.truncated ? h(doc, "span", { className: "tag" }, ["已截断"]) : null,
      locator ? h(doc, "span", { className: "tag" }, [locator]) : null,
      `${item.id ? `[${item.id}] ` : ""}${item.title}`,
    ]);
  }

  // ---- 右栏：材料、分歧、历史 ----

  private renderRight(): void {
    const doc = this.doc;
    clear(this.rightEl);
    if (!this.project) {
      return;
    }
    const project = this.project;
    this.rightEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, [`材料（${project.evidence.length}）`]),
        ...(project.evidence.length === 0
          ? [h(doc, "div", { className: "muted" }, ["尚无材料。"])]
          : project.evidence.map((item) =>
              h(doc, "div", { className: "evidence" }, [
                this.evidenceHeader(item),
                h(doc, "div", { className: "text" }, [item.text]),
                h(doc, "div", { className: "row" }, [
                  h(
                    doc,
                    "button",
                    {
                      onClick: () =>
                        void this.guard(() => this.runtime.openSource(item)),
                    },
                    ["来源"],
                  ),
                  h(
                    doc,
                    "button",
                    {
                      className: "danger",
                      disabled: this.run?.state === "running",
                      onClick: () =>
                        void this.guard(async () => {
                          this.project = await this.runtime.removeEvidence(
                            project,
                            item.id,
                          );
                          this.pendingRun = null;
                          await this.reloadProjects();
                          this.setNotice(
                            "材料已移除；已有讨论快照保持不变，重新讨论前请重新生成预览。",
                            "warn",
                          );
                          this.renderAll();
                        }),
                    },
                    ["移除"],
                  ),
                ]),
              ]),
            )),
      ]),
    );
    const disagreements = this.cards.flatMap((card) =>
      (card.edited ?? card.generated).disagreements.map(
        (text) => `${(card.edited ?? card.generated).title}：${text}`,
      ),
    );
    this.rightEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["未解决分歧"]),
        disagreements.length === 0
          ? h(doc, "div", { className: "muted" }, ["暂无。"])
          : h(
              doc,
              "ul",
              { className: "list" },
              disagreements.map((text) =>
                h(doc, "li", { style: "cursor:default" }, [text]),
              ),
            ),
      ]),
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["讨论历史"]),
        this.runs.length === 0
          ? h(doc, "div", { className: "muted" }, ["尚未讨论。"])
          : h(
              doc,
              "ul",
              { className: "list" },
              this.runs.map((run) =>
                h(
                  doc,
                  "li",
                  {
                    className: this.run?.id === run.id ? "active" : "",
                    onClick: () => {
                      this.run = run;
                      this.pendingRun = null;
                      if (this.view !== "project") {
                        this.view = "project";
                        this.renderMain();
                      } else {
                        this.renderRunPanel();
                      }
                      this.renderRight();
                    },
                  },
                  [
                    `${RUN_STATE_LABELS[run.state]} · ${run.requestsUsed} 次请求`,
                    h(doc, "span", { className: "meta" }, [formatTime(run.createdAt)]),
                  ],
                ),
              ),
            ),
      ]),
    );
  }

  // ---- 设置 ----

  private renderSettings(): void {
    const doc = this.doc;
    const settings: ProviderSettings = this.runtime.getProviderSettings();
    const budget = this.runtime.getBudget();
    const listEl = h(doc, "div", {});
    const bindingsEl = h(doc, "div", {});

    const renderBindings = () => {
      clear(bindingsEl);
      const options = [
        { value: "", label: "（未绑定）" },
        ...settings.models.map((model) => ({
          value: model.id,
          label: `${model.label || model.id} · ${model.model}`,
        })),
      ];
      for (const role of ROLES) {
        const roleSelect = select(doc, options, settings.bindings[role]);
        roleSelect.addEventListener("change", () => {
          settings.bindings[role] = roleSelect.value;
        });
        bindingsEl.append(field(doc, ROLE_LABELS[role], roleSelect));
      }
    };

    const renderModel = (model: ModelConfig): HTMLElement => {
      const label = input(doc, "text", model.label, { placeholder: "显示名称" });
      label.addEventListener("input", () => {
        model.label = label.value;
      });
      const baseURL = input(doc, "url", model.baseURL, {
        placeholder: "https://api.example.com/v1",
      });
      baseURL.addEventListener("input", () => {
        model.baseURL = baseURL.value.trim();
      });
      const modelName = input(doc, "text", model.model, { placeholder: "模型名称" });
      modelName.addEventListener("input", () => {
        model.model = modelName.value.trim();
      });
      const tokenField = select(
        doc,
        [
          { value: "max_tokens", label: "max_tokens" },
          { value: "max_completion_tokens", label: "max_completion_tokens" },
        ],
        model.outputTokenField,
      );
      tokenField.addEventListener("change", () => {
        model.outputTokenField = tokenField.value as ModelConfig["outputTokenField"];
      });
      const allowLocal = input(doc, "checkbox", "");
      allowLocal.checked = model.allowLocal;
      allowLocal.addEventListener("change", () => {
        model.allowLocal = allowLocal.checked;
      });
      const keyInput = input(doc, "password", "", {
        placeholder: "API key（只保存到 Login Manager 或本次会话）",
        autocomplete: "off",
      });
      const persist = input(doc, "checkbox", "");
      persist.checked = true;
      const keyStatus = h(doc, "span", { className: "muted" }, ["密钥状态：检查中…"]);
      void this.runtime.credentials
        .has(model.id)
        .then((saved) => {
          keyStatus.textContent = saved ? "密钥状态：已保存" : "密钥状态：未保存";
        })
        .catch(() => {
          keyStatus.textContent = "密钥状态：无法读取";
        });
      return h(doc, "div", { className: "evidence" }, [
        field(doc, "显示名称", label),
        field(
          doc,
          "服务地址（仅 HTTPS；HTTP 仅限勾选“允许本机”后的 127.0.0.1 / localhost）",
          baseURL,
        ),
        field(doc, "模型", modelName),
        field(doc, "输出上限字段", tokenField),
        h(doc, "label", {}, [
          allowLocal,
          " 允许本机 HTTP 服务（127.0.0.1、localhost、[::1]）",
        ]),
        h(doc, "div", { className: "row" }, [
          keyInput,
          h(doc, "label", {}, [persist, " 保存到 Login Manager"]),
          h(
            doc,
            "button",
            {
              onClick: () =>
                void this.guard(async () => {
                  if (!keyInput.value.trim()) {
                    throw new ExplorerError("EMPTY_KEY", "请输入 API key");
                  }
                  await this.runtime.credentials.set(
                    model.id,
                    keyInput.value.trim(),
                    persist.checked,
                  );
                  keyInput.value = "";
                  keyStatus.textContent = persist.checked
                    ? "密钥状态：已保存"
                    : "密钥状态：仅本次会话";
                }),
            },
            ["保存密钥"],
          ),
          h(
            doc,
            "button",
            {
              className: "danger",
              onClick: () =>
                void this.guard(async () => {
                  await this.runtime.credentials.remove(model.id);
                  keyStatus.textContent = "密钥状态：未保存";
                }),
            },
            ["删除密钥"],
          ),
          keyStatus,
        ]),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              className: "danger",
              onClick: () =>
                void this.guard(async () => {
                  settings.models = settings.models.filter(
                    (item) => item.id !== model.id,
                  );
                  for (const role of ROLES) {
                    if (settings.bindings[role] === model.id) {
                      settings.bindings[role] = "";
                    }
                  }
                  await this.runtime.credentials
                    .remove(model.id)
                    .catch(() => undefined);
                  renderList();
                  renderBindings();
                }),
            },
            ["删除此配置"],
          ),
        ]),
      ]);
    };

    const renderList = () => {
      clear(listEl);
      if (settings.models.length === 0) {
        listEl.append(h(doc, "div", { className: "muted" }, ["尚未添加模型配置。"]));
      }
      for (const model of settings.models) {
        listEl.append(renderModel(model));
      }
    };
    renderList();
    renderBindings();

    const maxRequests = input(doc, "number", String(budget.maxRequests), {
      min: "1",
      max: "12",
    });
    const maxOutput = input(doc, "number", String(budget.maxOutputTokens), {
      min: "256",
      max: "16384",
    });

    this.mainEl.append(
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["模型配置"]),
        h(doc, "div", { className: "notice" }, [
          "首版只支持 OpenAI-compatible Chat Completions 非流式接口。插件不会自动测试密钥、不会读取其他程序的密钥；密钥保存在 Zotero 的 Login Manager，不写入偏好文件。",
        ]),
        listEl,
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              onClick: () => {
                settings.models.push(this.runtime.newModelConfig());
                renderList();
                renderBindings();
              },
            },
            ["添加配置"],
          ),
        ]),
      ]),
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["角色绑定"]),
        h(doc, "div", { className: "muted" }, [
          "四个角色可以共用同一配置；共用时预览会如实标注它们不是彼此独立的专家。",
        ]),
        bindingsEl,
      ]),
      h(doc, "div", { className: "section" }, [
        h(doc, "h2", {}, ["预算"]),
        field(doc, "每轮最多请求数（固定流程需要 6 次；重试可临时提高）", maxRequests),
        field(doc, "单次输出上限 tokens", maxOutput),
        h(doc, "div", { className: "row" }, [
          h(
            doc,
            "button",
            {
              className: "primary",
              onClick: () =>
                void this.guard(async () => {
                  this.runtime.saveProviderSettings(settings);
                  this.runtime.saveBudget({
                    maxRequests: Number(maxRequests.value),
                    maxOutputTokens: Number(maxOutput.value),
                  });
                  this.pendingRun = null;
                  this.setNotice("设置已保存；已有预览需重新生成。", "ok");
                }),
            },
            ["保存设置"],
          ),
        ]),
      ]),
    );
  }
}
