import {
  type ChatRequest,
  type ChatResponse,
  type ChatTransport,
  type Evidence,
  type ExplorerStore,
  type ExploreOutput,
  type ReviewOutput,
  type Role,
  type Run,
  type Snapshot,
  type StepName,
  type StepOutput,
  type StepRecord,
  type SynthesisOutput,
  type TopicCard,
  STEP_NAMES,
} from "../domain/types.ts";
import { ExplorerError, newID, safeError } from "../domain/errors.ts";
import { checkInputByteLimit, validateBudget } from "./budget.ts";
import {
  buildExplorePrompt,
  buildFeasibilityChallengePrompt,
  buildFeasibilityPrompt,
  buildLiteratureChallengePrompt,
  buildLiteraturePrompt,
  buildSynthesizePrompt,
} from "./prompts.ts";

export type StepValidator = (
  name: StepName,
  raw: string,
  evidence: Evidence[],
  candidateIds?: string[],
) => StepOutput;

export type FingerprintComputer = (snapshot: Snapshot) => string;

export interface ExplorerControllerOptions {
  onChange?: (run: Run) => void;
  validateOutput?: StepValidator;
  computeFingerprint?: FingerprintComputer;
}

interface ActiveRunContext {
  abortController: AbortController;
  isCancelled: boolean;
  totalTimer?: NodeJS.Timeout;
}

let cachedValidator: StepValidator | null = null;
let cachedFingerprinter: FingerprintComputer | null = null;

async function getValidator(injected?: StepValidator): Promise<StepValidator> {
  if (injected) return injected;
  if (cachedValidator) return cachedValidator;
  try {
    const mod = await import("../domain/schemas.ts");
    cachedValidator = (mod as { validateStepOutput: StepValidator }).validateStepOutput;
    return cachedValidator;
  } catch (err) {
    throw new ExplorerError(
      "DEPENDENCY_MISSING",
      `src/domain/schemas.ts 尚未就绪 (${(err as Error).message})`,
    );
  }
}

async function getFingerprinter(
  injected?: FingerprintComputer,
): Promise<FingerprintComputer> {
  if (injected) return injected;
  if (cachedFingerprinter) return cachedFingerprinter;
  try {
    const mod = await import("../domain/hash.ts");
    cachedFingerprinter = (mod as { snapshotFingerprint: FingerprintComputer })
      .snapshotFingerprint;
    return cachedFingerprinter;
  } catch (err) {
    throw new ExplorerError(
      "DEPENDENCY_MISSING",
      `src/domain/hash.ts 尚未就绪 (${(err as Error).message})`,
    );
  }
}

export class ExplorerController {
  private store: ExplorerStore;
  private transport: ChatTransport;
  private options: ExplorerControllerOptions;
  private activeRuns = new Map<string, ActiveRunContext>();

  constructor(
    store: ExplorerStore,
    transport: ChatTransport,
    options: ExplorerControllerOptions = {},
  ) {
    this.store = store;
    this.transport = transport;
    this.options = options;
  }

  private notifyChange(run: Run): void {
    if (this.options.onChange) {
      try {
        this.options.onChange(run);
      } catch {
        // UI 监听器异常不破坏主流程
      }
    }
  }

  async prepare(projectId: string, snapshot: Snapshot): Promise<Run> {
    const validBudget = validateBudget(snapshot.budget);
    const sanitizedSnapshot: Snapshot = {
      ...snapshot,
      budget: validBudget,
    };

    const fingerprinter = await getFingerprinter(this.options.computeFingerprint);
    const fingerprint = fingerprinter(sanitizedSnapshot);

    const steps: StepRecord[] = STEP_NAMES.map((name) => ({
      name,
      state: "pending",
      attempts: [],
    }));

    const now = Date.now();
    const run: Run = {
      id: newID("run"),
      projectId,
      snapshot: sanitizedSnapshot,
      fingerprint,
      state: "awaiting_confirmation",
      steps,
      requestsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.createRun(run);
    this.notifyChange(run);
    return run;
  }

  async start(runId: string, expectedFingerprint: string): Promise<void> {
    if (this.activeRuns.has(runId)) {
      throw new ExplorerError("RUN_ALREADY_ACTIVE", "该运行正在执行中，禁止并发启动");
    }

    const run = await this.store.getRun(runId);
    if (!run) {
      throw new ExplorerError("RUN_NOT_FOUND", `运行记录 ${runId} 不存在`);
    }

    if (run.state !== "awaiting_confirmation") {
      throw new ExplorerError(
        "INVALID_RUN_STATE",
        `无法启动处于 ${run.state} 状态的运行，必须为 awaiting_confirmation`,
      );
    }

    if (run.fingerprint !== expectedFingerprint) {
      throw new ExplorerError(
        "FINGERPRINT_MISMATCH",
        "快照指纹不匹配，材料或配置已被修改，必须重新确认",
      );
    }

    const abortController = new AbortController();
    const context: ActiveRunContext = {
      abortController,
      isCancelled: false,
    };

    const maxDurationMs = run.snapshot.budget.maxDurationMs;
    context.totalTimer = setTimeout(() => {
      context.abortController.abort(
        new ExplorerError("TIMEOUT", `运行超过最大允许时长限制 (${maxDurationMs}ms)`),
      );
    }, maxDurationMs);

    this.activeRuns.set(runId, context);

    const updatedRun = await this.store.updateRun(runId, (r) => {
      r.state = "running";
      r.startedAt = Date.now();
      r.error = undefined;
      return r;
    });
    this.notifyChange(updatedRun);

    try {
      await this.executeWorkflow(runId, context);
    } finally {
      if (context.totalTimer) {
        clearTimeout(context.totalTimer);
      }
      this.activeRuns.delete(runId);
    }
  }

  private async executeWorkflow(
    runId: string,
    context: ActiveRunContext,
  ): Promise<void> {
    try {
      let currentRun = (await this.store.getRun(runId))!;

      // ---------------- Step 1: Explore ----------------
      let exploreOutput = this.getStepOutput<ExploreOutput>(currentRun, "explore");
      if (!exploreOutput) {
        exploreOutput = (await this.executeSingleStep(
          runId,
          "explore",
          "explorer",
          context,
          () =>
            buildExplorePrompt(
              currentRun.snapshot.constraints,
              currentRun.snapshot.evidence,
            ),
        )) as ExploreOutput;
      }

      this.checkCancellation(context);
      currentRun = (await this.store.getRun(runId))!;
      const candidates = exploreOutput.candidates;
      const candidateIds = candidates.map((c) => c.id);

      // ---------------- Step 2 & 3: Literature + Feasibility (并行独立) ----------------
      let litOutput = this.getStepOutput<ReviewOutput>(currentRun, "literature");
      let feasOutput = this.getStepOutput<ReviewOutput>(currentRun, "feasibility");

      const reviewPromises: Promise<void>[] = [];

      if (!litOutput) {
        reviewPromises.push(
          (async () => {
            litOutput = (await this.executeSingleStep(
              runId,
              "literature",
              "literature",
              context,
              () => buildLiteraturePrompt(candidates, currentRun.snapshot.evidence),
              candidateIds,
            )) as ReviewOutput;
          })(),
        );
      }

      if (!feasOutput) {
        reviewPromises.push(
          (async () => {
            feasOutput = (await this.executeSingleStep(
              runId,
              "feasibility",
              "feasibility",
              context,
              () =>
                buildFeasibilityPrompt(
                  candidates,
                  currentRun.snapshot.constraints,
                  currentRun.snapshot.evidence,
                ),
              candidateIds,
            )) as ReviewOutput;
          })(),
        );
      }

      if (reviewPromises.length > 0) {
        await Promise.all(reviewPromises);
      }

      this.checkCancellation(context);
      currentRun = (await this.store.getRun(runId))!;

      // ---------------- Step 4 & 5: Literature Challenge + Feasibility Challenge (并行各一次) ----------------
      let litChallengeOutput = this.getStepOutput<ReviewOutput>(
        currentRun,
        "literature_challenge",
      );
      let feasChallengeOutput = this.getStepOutput<ReviewOutput>(
        currentRun,
        "feasibility_challenge",
      );

      const challengePromises: Promise<void>[] = [];

      if (!litChallengeOutput) {
        challengePromises.push(
          (async () => {
            litChallengeOutput = (await this.executeSingleStep(
              runId,
              "literature_challenge",
              "literature",
              context,
              () =>
                buildLiteratureChallengePrompt(
                  candidates,
                  litOutput!.reviews,
                  feasOutput!.reviews,
                  currentRun.snapshot.evidence,
                ),
              candidateIds,
            )) as ReviewOutput;
          })(),
        );
      }

      if (!feasChallengeOutput) {
        challengePromises.push(
          (async () => {
            feasChallengeOutput = (await this.executeSingleStep(
              runId,
              "feasibility_challenge",
              "feasibility",
              context,
              () =>
                buildFeasibilityChallengePrompt(
                  candidates,
                  litOutput!.reviews,
                  feasOutput!.reviews,
                  currentRun.snapshot.constraints,
                  currentRun.snapshot.evidence,
                ),
              candidateIds,
            )) as ReviewOutput;
          })(),
        );
      }

      if (challengePromises.length > 0) {
        await Promise.all(challengePromises);
      }

      this.checkCancellation(context);
      currentRun = (await this.store.getRun(runId))!;

      // ---------------- Step 6: Synthesize ----------------
      let synthOutput = this.getStepOutput<SynthesisOutput>(currentRun, "synthesize");
      if (!synthOutput) {
        synthOutput = (await this.executeSingleStep(
          runId,
          "synthesize",
          "moderator",
          context,
          () =>
            buildSynthesizePrompt(
              candidates,
              litOutput!.reviews,
              feasOutput!.reviews,
              litChallengeOutput!.reviews,
              feasChallengeOutput!.reviews,
              currentRun.snapshot.constraints,
              currentRun.snapshot.evidence,
            ),
          candidateIds,
        )) as SynthesisOutput;
      }

      this.checkCancellation(context);

      // 全部 6 步成功完成：保存卡片并保留用户备注/编辑
      await this.saveSynthesizedCards(currentRun.projectId, runId, synthOutput.cards);

      // 标记运行完成
      const completedRun = await this.store.updateRun(runId, (r) => {
        r.state = "completed";
        return r;
      });
      this.notifyChange(completedRun);
    } catch (err) {
      if (context.isCancelled) {
        const cancelledRun = await this.store.updateRun(runId, (r) => {
          r.state = "cancelled";
          return r;
        });
        this.notifyChange(cancelledRun);
      } else {
        const runErr = safeError(err);
        const failedRun = await this.store.updateRun(runId, (r) => {
          r.state = "failed";
          r.error = runErr;
          return r;
        });
        this.notifyChange(failedRun);
      }
      throw err;
    }
  }

  private getStepOutput<T extends StepOutput>(run: Run, name: StepName): T | undefined {
    const step = run.steps.find((s) => s.name === name);
    if (step && step.state === "succeeded" && step.output) {
      return step.output as T;
    }
    return undefined;
  }

  private checkCancellation(context: ActiveRunContext): void {
    if (context.isCancelled || context.abortController.signal.aborted) {
      throw new ExplorerError("CANCELLED", "运行已取消");
    }
  }

  private async executeSingleStep(
    runId: string,
    stepName: StepName,
    role: Role,
    context: ActiveRunContext,
    promptBuilder: () => { system: string; user: string },
    candidateIds?: string[],
  ): Promise<StepOutput> {
    this.checkCancellation(context);

    // 1. 原子持久化 Attempt 与额度预留
    const attemptId = newID("att");
    const startedAt = Date.now();

    const runBeforeRequest = await this.store.updateRun(runId, (r) => {
      if (r.requestsUsed >= r.snapshot.budget.maxRequests) {
        throw new ExplorerError(
          "BUDGET_REQUESTS_EXCEEDED",
          `已达到最大请求次数上限 (${r.snapshot.budget.maxRequests})`,
        );
      }
      r.requestsUsed += 1;

      const step = r.steps.find((s) => s.name === stepName)!;
      step.state = "running";
      step.attempts.push({
        id: attemptId,
        startedAt,
        state: "running",
      });
      return r;
    });
    this.notifyChange(runBeforeRequest);

    // 2. 构建提示词与校验输入体积上限
    const modelConfig = runBeforeRequest.snapshot.models[role];
    if (!modelConfig) {
      throw new ExplorerError("MODEL_CONFIG_MISSING", `未配置角色 ${role} 的模型`);
    }

    const { system, user } = promptBuilder();
    const promptCombined = `${system}\n\n${user}`;
    checkInputByteLimit(promptCombined, runBeforeRequest.snapshot.budget.maxInputBytes);

    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];

    // 超时信号绑定
    const stepAbortController = new AbortController();
    const stepTimeout = setTimeout(() => {
      stepAbortController.abort(
        new ExplorerError(
          "TIMEOUT",
          `单次请求超时 (${runBeforeRequest.snapshot.budget.requestTimeoutMs}ms)`,
        ),
      );
    }, runBeforeRequest.snapshot.budget.requestTimeoutMs);

    const onParentAbort = () => {
      stepAbortController.abort(context.abortController.signal.reason);
    };
    context.abortController.signal.addEventListener("abort", onParentAbort);

    const request: ChatRequest = {
      config: modelConfig,
      messages,
      maxOutputTokens: runBeforeRequest.snapshot.budget.maxOutputTokens,
      timeoutMs: runBeforeRequest.snapshot.budget.requestTimeoutMs,
      signal: stepAbortController.signal,
    };

    let response: ChatResponse;
    try {
      response = await this.transport.complete(request);
    } catch (transportErr) {
      clearTimeout(stepTimeout);
      context.abortController.signal.removeEventListener("abort", onParentAbort);

      const isAborted =
        context.abortController.signal.aborted || stepAbortController.signal.aborted;
      const errState = isAborted ? "cancelled" : "failed";
      const runErr = safeError(transportErr);

      await this.store.updateRun(runId, (r) => {
        const step = r.steps.find((s) => s.name === stepName)!;
        const att = step.attempts.find((a) => a.id === attemptId)!;
        att.endedAt = Date.now();
        att.state = errState;
        att.error = runErr;
        step.state = errState;
        return r;
      });

      throw transportErr;
    } finally {
      clearTimeout(stepTimeout);
      context.abortController.signal.removeEventListener("abort", onParentAbort);
    }

    // 3. 收到响应：先持久化 raw 与 usage，再执行本地结构校验
    const receivedRun = await this.store.updateRun(runId, (r) => {
      const step = r.steps.find((s) => s.name === stepName)!;
      const att = step.attempts.find((a) => a.id === attemptId)!;
      att.endedAt = Date.now();
      att.raw = response.content;
      att.usage = response.usage;
      att.state = "received";
      step.state = "received";
      return r;
    });
    this.notifyChange(receivedRun);

    // 4. 本地结构与引用校验（坏 JSON 或假引用不自动重试，原错原样保存）
    let validatedOutput: StepOutput;
    try {
      const validator = await getValidator(this.options.validateOutput);
      validatedOutput = validator(
        stepName,
        response.content,
        receivedRun.snapshot.evidence,
        candidateIds,
      );
    } catch (valErr) {
      const valRunErr = safeError(valErr);
      await this.store.updateRun(runId, (r) => {
        const step = r.steps.find((s) => s.name === stepName)!;
        const att = step.attempts.find((a) => a.id === attemptId)!;
        att.state = "failed";
        att.error = valRunErr;
        step.state = "failed";
        return r;
      });
      throw valErr;
    }

    // 5. 校验成功，标记 step 与 attempt succeeded
    const succeededRun = await this.store.updateRun(runId, (r) => {
      const step = r.steps.find((s) => s.name === stepName)!;
      const att = step.attempts.find((a) => a.id === attemptId)!;
      att.state = "succeeded";
      step.state = "succeeded";
      step.output = validatedOutput;
      return r;
    });
    this.notifyChange(succeededRun);

    return validatedOutput;
  }

  private async saveSynthesizedCards(
    projectId: string,
    runId: string,
    cardsContent: TopicCard["generated"][],
  ): Promise<void> {
    const existingCards = await this.store.listCards(projectId);
    const existingMap = new Map(existingCards.map((c) => [c.generated.candidateId, c]));

    const now = Date.now();
    for (const cardContent of cardsContent) {
      const candidateId = cardContent.candidateId;
      const existing = existingMap.get(candidateId);

      if (existing) {
        // 保留人工 edited, notes, status, revision，仅更新 AI 生成版本并提示复核
        existing.runId = runId;
        existing.generated = cardContent;
        existing.needsReview = true;
        existing.updatedAt = now;
        await this.store.saveCard(existing, existing.revision);
      } else {
        const newCard: TopicCard = {
          id: newID("card"),
          projectId,
          runId,
          generated: cardContent,
          status: "exploring",
          notes: "",
          revision: 1,
          needsReview: false,
          createdAt: now,
          updatedAt: now,
        };
        await this.store.saveCard(newCard);
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.isCancelled = true;
      active.abortController.abort(new ExplorerError("CANCELLED", "用户手动取消运行"));
      this.activeRuns.delete(runId);
    }

    const updated = await this.store.updateRun(runId, (r) => {
      r.state = "cancelled";
      const now = Date.now();
      for (const step of r.steps) {
        if (step.state === "running" || step.state === "pending") {
          step.state = "cancelled";
          for (const att of step.attempts) {
            if (att.state === "running") {
              att.state = "cancelled";
              att.endedAt = now;
            }
          }
        }
      }
      return r;
    });

    this.notifyChange(updated);
  }

  async recover(): Promise<void> {
    const projects = await this.store.listProjects();
    const validator = await getValidator(this.options.validateOutput);

    for (const project of projects) {
      const runs = await this.store.listRuns(project.id);
      for (const run of runs) {
        if (run.state === "running") {
          await this.store.updateRun(run.id, (r) => {
            r.state = "interrupted";
            const now = Date.now();
            // 重验评审/汇总时沿用冻结的候选题 ID，与首次校验保持同一标准。
            const exploreStep = r.steps.find((step) => step.name === "explore");
            const candidateIds =
              exploreStep?.state === "succeeded" &&
              exploreStep.output &&
              "candidates" in exploreStep.output
                ? exploreStep.output.candidates.map((candidate) => candidate.id)
                : undefined;

            for (const step of r.steps) {
              if (step.state === "running" || step.state === "received") {
                const lastAttempt = step.attempts[step.attempts.length - 1];
                if (lastAttempt && lastAttempt.raw) {
                  // 有原始响应：在本地重新校验
                  try {
                    const output = validator(
                      step.name,
                      lastAttempt.raw,
                      r.snapshot.evidence,
                      step.name === "explore" ? undefined : candidateIds,
                    );
                    lastAttempt.state = "succeeded";
                    lastAttempt.endedAt = lastAttempt.endedAt || now;
                    step.state = "succeeded";
                    step.output = output;
                  } catch (valErr) {
                    lastAttempt.state = "failed";
                    lastAttempt.endedAt = lastAttempt.endedAt || now;
                    lastAttempt.error = safeError(valErr);
                    step.state = "failed";
                  }
                } else {
                  // 无原始响应：属于崩溃前在途请求，标为 result_unknown，预留额度不释放
                  if (lastAttempt) {
                    lastAttempt.state = "result_unknown";
                    lastAttempt.endedAt = lastAttempt.endedAt || now;
                  }
                  step.state = "result_unknown";
                }
              }
            }
            return r;
          });
        }
      }
    }
  }

  async prepareRetry(
    runId: string,
    maxRequests?: number,
    acknowledgeUnknown?: boolean,
  ): Promise<Run> {
    if (this.activeRuns.has(runId)) {
      throw new ExplorerError("RUN_STILL_RUNNING", "运行正在进行中，无法重试");
    }

    const run = await this.store.getRun(runId);
    if (!run) {
      throw new ExplorerError("RUN_NOT_FOUND", `运行记录 ${runId} 不存在`);
    }

    if (run.state === "completed") {
      throw new ExplorerError("RUN_ALREADY_COMPLETED", "已完成的运行无需重试");
    }

    // 检查是否存在 result_unknown 阶段
    const hasUnknown = run.steps.some(
      (s) =>
        s.state === "result_unknown" ||
        s.attempts.some((a) => a.state === "result_unknown"),
    );

    if (hasUnknown && !acknowledgeUnknown) {
      throw new ExplorerError(
        "UNKNOWN_STATE_UNACKNOWLEDGED",
        "存在结果未知的阶段，重试可能导致上游重复计费，须显式确认 acknowledgeUnknown",
      );
    }

    // 预算调整或校验
    let newBudget = { ...run.snapshot.budget };
    if (maxRequests !== undefined) {
      newBudget = validateBudget({
        ...newBudget,
        maxRequests,
      });
      if (maxRequests <= run.requestsUsed) {
        throw new ExplorerError(
          "BUDGET_INSUFFICIENT",
          `新预算上限 (${maxRequests}) 必须大于已消耗请求数 (${run.requestsUsed})`,
        );
      }
    } else {
      if (run.requestsUsed >= run.snapshot.budget.maxRequests) {
        throw new ExplorerError(
          "BUDGET_EXHAUSTED",
          `已消耗全部请求额度 (${run.requestsUsed}/${run.snapshot.budget.maxRequests})，需提供更高的 maxRequests`,
        );
      }
    }

    // 确定受影响的下游阶段并重置（保留 attempts 历史）
    // 依赖链：
    // explore (0) -> literature (1), feasibility (2) -> lit_challenge (3), feas_challenge (4) -> synthesize (5)
    const resetStepNames = new Set<StepName>();

    const isStepFailed = (name: StepName): boolean => {
      const s = run.steps.find((st) => st.name === name);
      return !s || s.state !== "succeeded";
    };

    if (isStepFailed("explore")) {
      STEP_NAMES.forEach((n) => resetStepNames.add(n));
    } else {
      if (isStepFailed("literature") || isStepFailed("feasibility")) {
        if (isStepFailed("literature")) resetStepNames.add("literature");
        if (isStepFailed("feasibility")) resetStepNames.add("feasibility");
        resetStepNames.add("literature_challenge");
        resetStepNames.add("feasibility_challenge");
        resetStepNames.add("synthesize");
      } else {
        if (
          isStepFailed("literature_challenge") ||
          isStepFailed("feasibility_challenge")
        ) {
          if (isStepFailed("literature_challenge"))
            resetStepNames.add("literature_challenge");
          if (isStepFailed("feasibility_challenge"))
            resetStepNames.add("feasibility_challenge");
          resetStepNames.add("synthesize");
        } else if (isStepFailed("synthesize")) {
          resetStepNames.add("synthesize");
        }
      }
    }

    const fingerprinter = await getFingerprinter(this.options.computeFingerprint);
    const updatedSnapshot: Snapshot = {
      ...run.snapshot,
      budget: newBudget,
    };
    const newFingerprint = `${fingerprinter(updatedSnapshot)}-retry-${Date.now().toString(36)}`;

    const updatedRun = await this.store.updateRun(runId, (r) => {
      r.snapshot = updatedSnapshot;
      r.fingerprint = newFingerprint;
      r.state = "awaiting_confirmation";
      r.error = undefined;

      for (const s of r.steps) {
        if (resetStepNames.has(s.name)) {
          s.state = "pending";
          s.output = undefined;
          // 注意：保留 s.attempts 历史记录，不予清空
        }
      }
      return r;
    });

    this.notifyChange(updatedRun);
    return updatedRun;
  }

  async shutdown(): Promise<void> {
    for (const context of this.activeRuns.values()) {
      context.isCancelled = true;
      context.abortController.abort(new ExplorerError("SHUTDOWN", "系统关闭"));
      if (context.totalTimer) {
        clearTimeout(context.totalTimer);
      }
    }
    this.activeRuns.clear();
  }
}
