import { expect } from "chai";
import { ExplorerController } from "../../src/agents/orchestrator.ts";
import { MemoryExplorerStore } from "../fixtures/memoryStore.ts";
import { MockTransport } from "../fixtures/mockTransport.ts";
import {
  mockSnapshotFingerprint,
  mockValidateStepOutput,
} from "../fixtures/mockDomain.ts";
import {
  sampleSnapshot,
  sampleExploreOutput,
  sampleLitReviewOutput,
  sampleFeasReviewOutput,
  sampleLitChallengeOutput,
  sampleFeasChallengeOutput,
  sampleSynthesisOutput,
} from "../fixtures/sampleData.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

describe("ExplorerController 6步编排与状态流转", function () {
  let store: MemoryExplorerStore;
  let transport: MockTransport;
  let controller: ExplorerController;

  beforeEach(async function () {
    store = new MemoryExplorerStore();
    await store.initialize();
    await store.saveProject({
      id: "proj-1",
      name: "测试课题",
      constraints: sampleSnapshot.constraints,
      evidence: sampleSnapshot.evidence,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    transport = new MockTransport();
    controller = new ExplorerController(store, transport, {
      validateOutput: mockValidateStepOutput,
      computeFingerprint: mockSnapshotFingerprint,
    });
  });

  afterEach(async function () {
    await controller.shutdown();
    await store.close();
  });

  function setupStandardResponses(): void {
    transport.responses.set("Explorer", {
      content: JSON.stringify(sampleExploreOutput),
      usage: { inputTokens: 100, outputTokens: 200 },
    });
    transport.responses.set("Literature Reviewer", {
      content: JSON.stringify(sampleLitReviewOutput),
      usage: { inputTokens: 150, outputTokens: 250 },
    });
    transport.responses.set("Feasibility Reviewer", {
      content: JSON.stringify(sampleFeasReviewOutput),
      usage: { inputTokens: 150, outputTokens: 250 },
    });
    transport.responses.set("Moderator", {
      content: JSON.stringify(sampleSynthesisOutput),
      usage: { inputTokens: 300, outputTokens: 400 },
    });
  }

  it("未确认零调用：prepare 仅创建 Run 并不发送任何网络请求", async function () {
    const run = await controller.prepare("proj-1", sampleSnapshot);
    expect(run.state).to.equal("awaiting_confirmation");
    expect(run.fingerprint).to.include("fp-");
    expect(run.requestsUsed).to.equal(0);
    expect(run.steps).to.have.lengthOf(6);
    expect(transport.requests).to.have.lengthOf(0);

    const stored = await store.getRun(run.id);
    expect(stored).to.not.be.null;
    expect(stored!.state).to.equal("awaiting_confirmation");
  });

  it("指纹不匹配或并发启动应直接拒绝", async function () {
    const run = await controller.prepare("proj-1", sampleSnapshot);

    // 错误的指纹
    try {
      await controller.start(run.id, "wrong-fingerprint");
      expect.fail("应当拒绝启动");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("FINGERPRINT_MISMATCH");
    }

    // 状态非 awaiting_confirmation 时拒绝
    await store.updateRun(run.id, (r) => {
      r.state = "completed";
      return r;
    });
    try {
      await controller.start(run.id, run.fingerprint);
      expect.fail("应当拒绝非确认状态启动");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("INVALID_RUN_STATE");
    }
  });

  it("完整6次：依次完成 explore、两组并行审查与质询、以及 synthesize，并生成卡片", async function () {
    let callCount = 0;
    transport.customHandler = async (req) => {
      callCount++;
      const sys = req.messages.find((m) => m.role === "system")?.content || "";
      const user = req.messages.find((m) => m.role === "user")?.content || "";

      if (sys.includes("Explorer")) {
        return {
          content: JSON.stringify(sampleExploreOutput),
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      }
      if (sys.includes("Literature Reviewer")) {
        if (user.includes("第一轮")) {
          return {
            content: JSON.stringify(sampleLitChallengeOutput),
            usage: { inputTokens: 15, outputTokens: 25 },
          };
        }
        return {
          content: JSON.stringify(sampleLitReviewOutput),
          usage: { inputTokens: 15, outputTokens: 25 },
        };
      }
      if (sys.includes("Feasibility Reviewer")) {
        if (user.includes("第一轮")) {
          return {
            content: JSON.stringify(sampleFeasChallengeOutput),
            usage: { inputTokens: 15, outputTokens: 25 },
          };
        }
        return {
          content: JSON.stringify(sampleFeasReviewOutput),
          usage: { inputTokens: 15, outputTokens: 25 },
        };
      }
      if (sys.includes("Moderator")) {
        return {
          content: JSON.stringify(sampleSynthesisOutput),
          usage: { inputTokens: 30, outputTokens: 40 },
        };
      }
      return { content: "{}", usage: { inputTokens: 0, outputTokens: 0 } };
    };

    const run = await controller.prepare("proj-1", sampleSnapshot);
    await controller.start(run.id, run.fingerprint);

    expect(callCount).to.equal(6);
    expect(transport.requests).to.have.lengthOf(6);

    const completedRun = (await store.getRun(run.id))!;
    expect(completedRun.state).to.equal("completed");
    expect(completedRun.requestsUsed).to.equal(6);

    for (const step of completedRun.steps) {
      expect(step.state).to.equal("succeeded");
      expect(step.attempts).to.have.lengthOf(1);
      expect(step.attempts[0].state).to.equal("succeeded");
      expect(step.attempts[0].raw).to.be.a("string");
      expect(step.attempts[0].usage).to.not.be.undefined;
    }

    // 检查卡片落库
    const cards = await store.listCards("proj-1");
    expect(cards).to.have.lengthOf(2);
    const first = cards.find((c) => c.generated.candidateId === "cand-1")!;
    expect(first).to.not.be.undefined;
    expect(first.status).to.equal("exploring");
    expect(first.revision).to.equal(1);
    expect(cards.map((c) => c.generated.candidateId).sort()).to.deep.equal([
      "cand-1",
      "cand-2",
    ]);
  });

  it("坏 JSON 无隐形重试：失败立即终止，原始响应与错误保留且计入额度", async function () {
    let calls = 0;
    transport.customHandler = async () => {
      calls++;
      return {
        content: "{ corrupted json from provider --- ",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    };

    const run = await controller.prepare("proj-1", sampleSnapshot);
    try {
      await controller.start(run.id, run.fingerprint);
      expect.fail("坏 JSON 应当抛出异常");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
    }

    // 绝无第 2 次或隐形重试
    expect(calls).to.equal(1);

    const failedRun = (await store.getRun(run.id))!;
    expect(failedRun.state).to.equal("failed");
    expect(failedRun.requestsUsed).to.equal(1);

    const exploreStep = failedRun.steps.find((s) => s.name === "explore")!;
    expect(exploreStep.state).to.equal("failed");
    expect(exploreStep.attempts[0].raw).to.equal("{ corrupted json from provider --- ");
    expect(exploreStep.attempts[0].error).to.not.be.undefined;
    expect(exploreStep.attempts[0].error!.code).to.equal("SCHEMA_PARSE_ERROR");
  });

  it("取消操作：在途请求收到 Abort 信号且后续阶段不再执行", async function () {
    transport.delayMs = 50;
    setupStandardResponses();

    const run = await controller.prepare("proj-1", sampleSnapshot);
    const startPromise = controller.start(run.id, run.fingerprint);

    // 延迟 10ms 后发出取消
    await new Promise((r) => setTimeout(r, 10));
    await controller.cancel(run.id);

    try {
      await startPromise;
    } catch {
      // expected cancellation rejection
    }

    const cancelledRun = (await store.getRun(run.id))!;
    expect(cancelledRun.state).to.equal("cancelled");

    // 取消后请求数不超过取消前的消耗
    expect(transport.requests.length).to.be.at.most(2);
  });

  it("请求预算上限保护：超出预算拒绝后续请求并标记失败", async function () {
    setupStandardResponses();
    const tightSnapshot = {
      ...sampleSnapshot,
      budget: {
        ...sampleSnapshot.budget,
        maxRequests: 2, // 仅允许 2 次请求
      },
    };

    const run = await controller.prepare("proj-1", tightSnapshot);
    try {
      await controller.start(run.id, run.fingerprint);
      expect.fail("应当由于额度不足而失败");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("BUDGET_REQUESTS_EXCEEDED");
    }

    const failedRun = (await store.getRun(run.id))!;
    expect(failedRun.state).to.equal("failed");
    expect(failedRun.requestsUsed).to.equal(2);
  });

  it("崩溃恢复（recover）与断点重试（prepareRetry）", async function () {
    // 模拟运行到中间崩溃：explore 成功，literature 成功，feasibility 正在请求中且未收到 raw
    const run = await controller.prepare("proj-1", sampleSnapshot);
    await store.updateRun(run.id, (r) => {
      r.state = "running";
      r.requestsUsed = 3;

      const exp = r.steps.find((s) => s.name === "explore")!;
      exp.state = "succeeded";
      exp.output = sampleExploreOutput;
      exp.attempts.push({
        id: "att-1",
        startedAt: Date.now(),
        state: "succeeded",
        raw: JSON.stringify(sampleExploreOutput),
      });

      const lit = r.steps.find((s) => s.name === "literature")!;
      lit.state = "succeeded";
      lit.output = sampleLitReviewOutput;
      lit.attempts.push({
        id: "att-2",
        startedAt: Date.now(),
        state: "succeeded",
        raw: JSON.stringify(sampleLitReviewOutput),
      });

      const feas = r.steps.find((s) => s.name === "feasibility")!;
      feas.state = "running";
      feas.attempts.push({ id: "att-3", startedAt: Date.now(), state: "running" }); // 无 raw
      return r;
    });

    // 1. 系统重启恢复
    await controller.recover();

    const recoveredRun = (await store.getRun(run.id))!;
    expect(recoveredRun.state).to.equal("interrupted");
    const feasStep = recoveredRun.steps.find((s) => s.name === "feasibility")!;
    expect(feasStep.state).to.equal("result_unknown");
    // unknown 预留额度不释放
    expect(recoveredRun.requestsUsed).to.equal(3);

    // 2. prepareRetry 未确认 unknown 时拒绝
    try {
      await controller.prepareRetry(run.id, 10, false);
      expect.fail("未确认 unknown 应当报错");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("UNKNOWN_STATE_UNACKNOWLEDGED");
    }

    // 3. 显式确认 acknowledgeUnknown 并补充预算
    const retriedRun = await controller.prepareRetry(run.id, 10, true);
    expect(retriedRun.state).to.equal("awaiting_confirmation");
    expect(retriedRun.fingerprint).to.not.equal(run.fingerprint);

    // explore 和 literature 仍为 succeeded，feasibility 及下游重置为 pending
    expect(retriedRun.steps.find((s) => s.name === "explore")!.state).to.equal(
      "succeeded",
    );
    expect(retriedRun.steps.find((s) => s.name === "literature")!.state).to.equal(
      "succeeded",
    );
    expect(retriedRun.steps.find((s) => s.name === "feasibility")!.state).to.equal(
      "pending",
    );
    expect(retriedRun.steps.find((s) => s.name === "synthesize")!.state).to.equal(
      "pending",
    );

    // 历史 attempts 保留
    expect(
      retriedRun.steps.find((s) => s.name === "feasibility")!.attempts,
    ).to.have.lengthOf(1);

    // 4. 重试启动：仅执行未成功的阶段
    setupStandardResponses();
    await controller.start(retriedRun.id, retriedRun.fingerprint);

    const finalRun = (await store.getRun(run.id))!;
    expect(finalRun.state).to.equal("completed");
    // feasibility (1) + 2 challenges (2) + synthesize (1) = 4 新请求，加上之前消耗的 3 = 7
    expect(finalRun.requestsUsed).to.equal(7);
  });

  it("卡片用户改动保护：综合重新生成时不覆盖用户已编辑内容和状态", async function () {
    setupStandardResponses();

    // 1. 初次运行生成卡片
    const run1 = await controller.prepare("proj-1", sampleSnapshot);
    await controller.start(run1.id, run1.fingerprint);

    const cards = await store.listCards("proj-1");
    expect(cards).to.have.lengthOf(2);
    const card1 = cards[0];

    // 2. 用户在前端手动编辑卡片并添加笔记
    card1.edited = {
      ...card1.generated,
      title: "用户修改后的标题",
    };
    card1.notes = "这是用户的手动研判笔记，极其重要";
    card1.status = "experiment";
    await store.saveCard(card1, card1.revision);

    // 3. 再次运行综合或新一次探索产生相同 candidateId
    const run2 = await controller.prepare("proj-1", sampleSnapshot);
    await controller.start(run2.id, run2.fingerprint);

    const updatedCards = await store.listCards("proj-1");
    const updatedCard1 = updatedCards.find((c) => c.id === card1.id)!;

    // 核心保护断言：用户人工修改不受 AI 覆盖
    expect(updatedCard1.edited?.title).to.equal("用户修改后的标题");
    expect(updatedCard1.notes).to.equal("这是用户的手动研判笔记，极其重要");
    expect(updatedCard1.status).to.equal("experiment");
    expect(updatedCard1.needsReview).to.be.true; // 标记提示复核
    expect(updatedCard1.revision).to.equal(3); // 初次 1 -> 用户改 2 -> AI 覆盖更新 3
  });
});
