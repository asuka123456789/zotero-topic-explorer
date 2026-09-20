import { ExplorerController } from "../../src/agents/orchestrator.ts";
import { hashText } from "../../src/domain/hash.ts";
import type {
  ChatRequest,
  ChatResponse,
  ChatTransport,
  Evidence,
  ExplorerStore,
  Snapshot,
} from "../../src/domain/types.ts";
import {
  SQLiteExplorerStore,
  type SQLiteConnection,
} from "../../src/storage/sqliteStore.ts";
import { collectSelection } from "../../src/zotero/selection.ts";
import { collectEvidence } from "../../src/zotero/evidence.ts";
import { CredentialStore } from "../../src/zotero/credentials.ts";

declare const expect: Chai.ExpectStatic;

const PREFIX = "extensions.zotero.zotero-topic-explorer";
const ISOLATED_PREF = `${PREFIX}.test.isolated`;

function assertIsolated(): void {
  const dataDir = Zotero.DataDirectory.dir.replace(/\\/g, "/");
  if (
    !dataDir.endsWith("/.scaffold/test/data") ||
    Zotero.Prefs.get(ISOLATED_PREF, true) !== true
  ) {
    throw new Error("集成测试只允许在 .scaffold/test/data 隔离文库中运行");
  }
}

function evidence(id: string, text: string): Evidence {
  return {
    id,
    libraryID: Zotero.Libraries.userLibraryID,
    itemKey: "SYNTHET1",
    kind: "abstract",
    title: "合成文献",
    text,
    hash: hashText(text),
    extraction: "test",
    truncated: false,
  };
}

/** 本地假传输：不产生任何网络请求。 */
class ScriptedTransport implements ChatTransport {
  requests: ChatRequest[] = [];
  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const system = request.messages[0]?.content ?? "";
    const user = request.messages[1]?.content ?? "";
    const quote = "可在两周内完成最小验证";
    const claim = {
      kind: "fact",
      text: "材料指出可以快速验证。",
      citations: [{ evidenceId: "E1", quote }],
    };
    if (system.includes("Explorer")) {
      return {
        content: JSON.stringify({
          candidates: [
            {
              id: "C1",
              title: "候选一",
              question: "问题一？",
              rationale: "理由一",
              claims: [claim],
            },
            {
              id: "C2",
              title: "候选二",
              question: "问题二？",
              rationale: "理由二",
              claims: [],
            },
          ],
        }),
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }
    if (system.includes("Moderator")) {
      const card = (candidateId: string) => ({
        candidateId,
        title: `卡片 ${candidateId}`,
        question: "问题？",
        motivation: "动机",
        claims: [claim],
        differences: "区别",
        resources: "资源",
        minimumExperiment: "最小实验",
        stopConditions: ["条件"],
        disagreements: ["分歧"],
        nextSteps: ["下一步"],
      });
      return {
        content: JSON.stringify({ cards: [card("C1"), card("C2")] }),
        usage: { inputTokens: null, outputTokens: null },
      };
    }
    const review = (candidateId: string) => ({
      candidateId,
      assessment: user.includes("第一轮") ? "第二轮意见" : "第一轮意见",
      claims: [],
      objections: ["异议"],
      unknowns: ["待检索"],
    });
    return {
      content: JSON.stringify({ reviews: [review("C1"), review("C2")] }),
      usage: { inputTokens: 5, outputTokens: 5 },
    };
  }
}

describe("Zotero Topic Explorer 隔离集成测试", function () {
  this.timeout(60000);
  let item: Zotero.Item;
  let dbPath: string;
  let store: ExplorerStore | null = null;

  before(async function () {
    assertIsolated();
    item = new Zotero.Item("journalArticle");
    item.setField("title", "合成测试论文");
    item.setField("abstractNote", "该方案可在两周内完成最小验证。");
    item.setField("date", "2024");
    await item.saveTx();
    dbPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "topic-explorer-integration.sqlite",
    );
  });

  after(async function () {
    assertIsolated();
    await store?.close();
    const tests = this.test?.parent?.tests || [];
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "topic-explorer-result.json"),
      JSON.stringify({
        total: tests.length,
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
      }),
    );
  });

  it("插件已初始化并注册菜单", function () {
    const instance = (Zotero as any).TopicExplorer;
    expect(instance?.data?.initialized).to.equal(true);
    expect(instance.data.menuIDs.length).to.equal(3);
  });

  it("独立数据库可初始化并保存项目", async function () {
    const database = new Zotero.DBConnection(dbPath);
    const connection: SQLiteConnection = {
      queryAsync: (sql, params) => database.queryAsync(sql, params),
      valueQueryAsync: (sql, params) => database.valueQueryAsync(sql, params),
      executeTransaction: (operation) => database.executeTransaction(operation),
      closeDatabase: () => database.closeDatabase(true),
    };
    const sqlite = new SQLiteExplorerStore(connection);
    await sqlite.initialize();
    store = sqlite;
    const saved = await sqlite.saveProject({
      id: "project-it",
      name: "集成项目",
      constraints: {
        interests: "a",
        background: "b",
        time: "c",
        compute: "d",
        data: "e",
      },
      evidence: [],
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(saved.revision).to.equal(1);
    expect(await sqlite.getProject("project-it")).to.not.equal(null);
  });

  it("从真实 Zotero 条目只读收集书目与摘要", async function () {
    const win = Zotero.getMainWindow();
    await win.ZoteroPane.selectItem(item.id);
    const targets = await collectSelection(win as unknown as Window);
    expect(targets.map((target) => target.itemKey)).to.deep.equal([item.key]);
    const result = await collectEvidence(targets);
    expect(result.evidence.some((entry) => entry.kind === "abstract")).to.equal(true);
    for (const entry of result.evidence) {
      expect(entry.hash).to.equal(hashText(entry.text));
      expect(JSON.stringify(entry)).to.not.include("\\\\");
    }
    expect(item.getField("title")).to.equal("合成测试论文");
  });

  it("完整 6 次讨论只走本地假传输并生成卡片", async function () {
    if (!store) {
      throw new Error("存储未初始化");
    }
    const transport = new ScriptedTransport();
    const controller = new ExplorerController(store, transport);
    const model = {
      id: "fake",
      label: "fake",
      baseURL: "https://example.invalid/v1",
      model: "fake",
      outputTokenField: "max_tokens" as const,
      allowLocal: false,
    };
    const snapshot: Snapshot = {
      protocolVersion: 1,
      constraints: {
        interests: "a",
        background: "b",
        time: "c",
        compute: "d",
        data: "e",
      },
      evidence: [evidence("E1", "该方案可在两周内完成最小验证。")],
      models: {
        explorer: model,
        literature: model,
        feasibility: model,
        moderator: model,
      },
      budget: {
        maxRequests: 6,
        maxInputBytes: 96000,
        maxOutputTokens: 3000,
        requestTimeoutMs: 30000,
        maxDurationMs: 120000,
      },
    };
    const run = await controller.prepare("project-it", snapshot);
    expect(transport.requests.length).to.equal(0);
    await controller.start(run.id, run.fingerprint);
    expect(transport.requests.length).to.equal(6);
    const finished = await store.getRun(run.id);
    expect(finished?.state).to.equal("completed");
    const cards = await store.listCards("project-it");
    expect(cards.length).to.equal(2);
    await controller.shutdown();
  });

  it("凭据仅存于插件 realm，并可删除", async function () {
    const credentials = new CredentialStore();
    await credentials.set("integration-config", "test-key-value", true);
    expect(await credentials.get("integration-config")).to.equal("test-key-value");
    await credentials.remove("integration-config");
    expect(await credentials.has("integration-config")).to.equal(false);
    expect(Zotero.Prefs.get(`${PREFIX}.providers`, true)).to.not.include(
      "test-key-value",
    );
  });

  it("工作台窗口可打开并关闭", async function () {
    const instance = (Zotero as any).TopicExplorer;
    const { openWorkbench, closeWorkbench } = await import("../../src/ui/workbench.ts");
    await openWorkbench(instance.data.runtime);
    const mostRecent = Services.wm.getMostRecentWindow as unknown as (
      type: string | null,
    ) => Window | null;
    const win = mostRecent(null);
    expect(win?.location.href).to.include("workbench.xhtml");
    closeWorkbench();
  });
});
