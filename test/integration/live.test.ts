import { ExplorerController } from "../../src/agents/orchestrator.ts";
import { hashText } from "../../src/domain/hash.ts";
import type {
  ChatRequest,
  ChatResponse,
  ChatTransport,
  Evidence,
  ModelConfig,
  Role,
  Run,
  Snapshot,
} from "../../src/domain/types.ts";
import { createTransport } from "../../src/providers/openaiCompatible.ts";
import {
  SQLiteExplorerStore,
  type SQLiteConnection,
} from "../../src/storage/sqliteStore.ts";
import { CredentialStore } from "../../src/zotero/credentials.ts";

declare const expect: Chai.ExpectStatic;

/**
 * 真实模型联调（可选）。未提供配置时整组跳过。两种配置方式：
 * 1. TOPIC_EXPLORER_LIVE_CONFIG：JSON 数组，按 探索、文献审查、可行性、主控 顺序给 4 项
 *    `{ "model", "baseURL", "apiKey", "allowLocal"? }`；不同角色可用不同服务与密钥。
 * 2. 简化变量：TOPIC_EXPLORER_LIVE_BASE_URL、TOPIC_EXPLORER_LIVE_API_KEY、
 *    TOPIC_EXPLORER_LIVE_MODELS（4 个模型名，逗号分隔，共用同一服务与密钥）。
 * 密钥只经 CredentialStore 会话内存，不落盘；材料全部是合成文本。
 */

const ISOLATED_PREF = "extensions.zotero.zotero-topic-explorer.test.isolated";
const ROLES: Role[] = ["explorer", "literature", "feasibility", "moderator"];

interface LiveRoleConfig {
  model: string;
  baseURL: string;
  apiKey: string;
  allowLocal?: boolean;
}

function env(name: string): string {
  try {
    return Services.env.exists(name) ? Services.env.get(name) : "";
  } catch {
    return "";
  }
}

function readLiveConfig(): LiveRoleConfig[] | null {
  const json = env("TOPIC_EXPLORER_LIVE_CONFIG");
  if (json) {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      throw new Error("TOPIC_EXPLORER_LIVE_CONFIG 必须是长度为 4 的数组");
    }
    return parsed.map((entry) => {
      const item = entry as Partial<LiveRoleConfig>;
      if (!item.model || !item.baseURL || !item.apiKey) {
        throw new Error("TOPIC_EXPLORER_LIVE_CONFIG 每项需要 model、baseURL、apiKey");
      }
      return {
        model: item.model,
        baseURL: item.baseURL,
        apiKey: item.apiKey,
        allowLocal: item.allowLocal === true,
      };
    });
  }
  const baseURL = env("TOPIC_EXPLORER_LIVE_BASE_URL");
  const apiKey = env("TOPIC_EXPLORER_LIVE_API_KEY");
  const models = env("TOPIC_EXPLORER_LIVE_MODELS")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!baseURL || !apiKey || models.length !== 4) {
    return null;
  }
  return models.map((model) => ({ model, baseURL, apiKey }));
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return "?";
  }
}

function synthetic(id: string, title: string, text: string): Evidence {
  return {
    id,
    libraryID: Zotero.Libraries.userLibraryID,
    itemKey: "SYNTHET1",
    kind: "abstract",
    title,
    text,
    hash: hashText(text),
    extraction: "synthetic",
    truncated: false,
  };
}

const EVIDENCE: Evidence[] = [
  synthetic(
    "E1",
    "合成文献 A：小样本条件下的轻量模型微调综述（虚构）",
    "本文（虚构）综述了在标注样本少于一千条时对轻量级模型进行微调的方法。作者报告，参数高效微调在三个虚构基准上的平均准确率比全量微调低 1.2 个百分点，但训练显存需求下降约 60%。文中指出，现有方法对标注噪声敏感，且缺乏在中文语料上的系统比较。",
  ),
  synthetic(
    "E2",
    "合成文献 B：面向单卡训练的课程学习策略（虚构）",
    "该研究（虚构）提出一种按难度排序样本的课程学习策略，在单张 24GB 显卡上把收敛所需迭代次数减少了 35%。作者承认该策略依赖一个额外的难度打分模型，打分模型本身需要约 4 小时预训练，且未在超过 10 万样本的数据集上验证。",
  ),
  synthetic(
    "E3",
    "合成文献 C：标注噪声对小数据集训练的影响（虚构）",
    "实验（虚构）表明，当标注错误率超过 15% 时，小数据集上的微调准确率会急剧下降；作者建议在微调前先用一致性检查过滤样本，并报告过滤后可恢复约 80% 的准确率损失。研究只覆盖英文文本分类任务。",
  ),
];

interface StepUsage {
  step: string;
  state: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  error?: string;
}

describe("Zotero Topic Explorer 真实模型联调（可选）", function () {
  this.timeout(900000);
  let liveConfig: LiveRoleConfig[] | null = null;
  let store: SQLiteExplorerStore | null = null;
  let finalRun: Run | null = null;
  const requestLog: Array<{
    role: string;
    model: string;
    host: string;
    bytes: number;
  }> = [];

  before(function () {
    const dataDir = Zotero.DataDirectory.dir.replace(/\\/g, "/");
    if (
      !dataDir.endsWith("/.scaffold/test/data") ||
      Zotero.Prefs.get(ISOLATED_PREF, true) !== true
    ) {
      throw new Error("联调只允许在 .scaffold/test/data 隔离文库中运行");
    }
    liveConfig = readLiveConfig();
    if (!liveConfig) {
      this.skip();
    }
  });

  after(async function () {
    await store?.close();
    const usage: StepUsage[] =
      finalRun?.steps.map((step) => {
        const last = step.attempts[step.attempts.length - 1];
        return {
          step: step.name,
          state: step.state,
          inputTokens: last?.usage?.inputTokens ?? null,
          outputTokens: last?.usage?.outputTokens ?? null,
          durationMs:
            last?.endedAt && last.startedAt ? last.endedAt - last.startedAt : null,
          error: last?.error ? `${last.error.code}: ${last.error.message}` : undefined,
        };
      }) ?? [];
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "topic-explorer-live-result.json"),
      JSON.stringify(
        {
          enabled: liveConfig !== null,
          roles: (liveConfig ?? []).map((item, index) => ({
            role: ROLES[index],
            model: item.model,
            host: hostOf(item.baseURL),
          })),
          state: finalRun?.state ?? null,
          requestsUsed: finalRun?.requestsUsed ?? null,
          error: finalRun?.error ?? null,
          usage,
          requests: requestLog,
        },
        null,
        2,
      ),
    );
  });

  it("用真实服务完成 6 步讨论并生成卡片（合成材料）", async function () {
    const config = liveConfig!;
    const database = new Zotero.DBConnection(
      PathUtils.join(Zotero.DataDirectory.dir, "topic-explorer-live.sqlite"),
    );
    const connection: SQLiteConnection = {
      queryAsync: (sql, params) => database.queryAsync(sql, params),
      valueQueryAsync: (sql, params) => database.valueQueryAsync(sql, params),
      executeTransaction: (operation) => database.executeTransaction(operation),
      closeDatabase: () => database.closeDatabase(true),
    };
    store = new SQLiteExplorerStore(connection);
    await store.initialize();
    await store.saveProject({
      id: "project-live",
      name: "联调项目",
      constraints: {
        interests: "在小样本、单卡条件下做出可复现的轻量模型训练改进；方向未定",
        background: "熟悉 PyTorch，做过文本分类，没有大规模训练经验",
        time: "每周约 15 小时，持续 3 个月",
        compute: "单张 24GB 显卡",
        data: "只有公开中文文本分类数据集，标注质量未知",
      },
      evidence: EVIDENCE,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 密钥只放会话内存，不写 Login Manager。
    const credentials = new CredentialStore();
    const models = {} as Record<Role, ModelConfig>;
    for (const [index, role] of ROLES.entries()) {
      const item = config[index];
      models[role] = {
        id: `live-${role}`,
        label: `live ${role}`,
        baseURL: item.baseURL,
        model: item.model,
        outputTokenField: "max_tokens",
        allowLocal: item.allowLocal === true,
      };
      await credentials.set(models[role].id, item.apiKey, false);
    }
    const real = createTransport((configId) => credentials.get(configId));
    const transport: ChatTransport = {
      async complete(request: ChatRequest): Promise<ChatResponse> {
        requestLog.push({
          role: request.config.id,
          model: request.config.model,
          host: hostOf(request.config.baseURL),
          bytes: new TextEncoder().encode(JSON.stringify(request.messages)).length,
        });
        return real.complete(request);
      },
    };
    const controller = new ExplorerController(store, transport);
    const snapshot: Snapshot = {
      protocolVersion: 1,
      constraints: (await store.getProject("project-live"))!.constraints,
      evidence: EVIDENCE,
      models,
      budget: {
        maxRequests: 6,
        maxInputBytes: 96000,
        maxOutputTokens: 12000,
        requestTimeoutMs: 240000,
        maxDurationMs: 1500000,
      },
    };
    const run = await controller.prepare("project-live", snapshot);
    expect(requestLog.length).to.equal(0);
    try {
      await controller.start(run.id, run.fingerprint);
    } finally {
      finalRun = await store.getRun(run.id);
      credentials.clearSession();
      await controller.shutdown();
    }
    expect(finalRun?.state).to.equal("completed");
    expect(requestLog.length).to.equal(6);
    const cards = await store.listCards("project-live");
    expect(cards.length).to.be.greaterThan(0);
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "topic-explorer-live-cards.json"),
      JSON.stringify(
        cards.map((card) => card.generated),
        null,
        2,
      ),
    );
  });
});
