import {
  type Candidate,
  type CardContent,
  type Constraints,
  type Evidence,
  type ExploreOutput,
  type ModelConfig,
  type Review,
  type ReviewOutput,
  type Snapshot,
  type SynthesisOutput,
} from "../../src/domain/types.ts";

export const sampleConstraints: Constraints = {
  interests: "大语言模型推理加速与多智能体协作",
  background: "计算机科学硕士，精通 Python/PyTorch，有分布式系统基础",
  time: "6 个月",
  compute: "单台 RTX 4090 (24GB)",
  data: "公开学术论文与基准评测集",
};

export const sampleEvidence: Evidence[] = [
  {
    id: "ev-1",
    libraryID: 1,
    itemKey: "ITEMKEY01",
    kind: "abstract",
    title: "Speculative Decoding for Faster LLM Inference",
    text: "Speculative decoding achieves 2-3x speedup without changing the output distribution by using a small draft model.",
    hash: "hash001",
    extraction: "abstract",
    pageLabel: "12",
    truncated: false,
  },
  {
    id: "ev-2",
    libraryID: 1,
    itemKey: "ITEMKEY02",
    kind: "pdf_excerpt",
    title: "Multi-Agent Debate Frameworks",
    text: "Iterative multi-agent debate reduces hallucinations in complex reasoning tasks through divergent perspective generation.",
    hash: "hash002",
    extraction: "pdf_excerpt",
    truncated: false,
  },
];

export const sampleModelConfig: ModelConfig = {
  id: "mock-model-1",
  label: "Mock GPT-4o",
  baseURL: "https://api.mock.openai.com/v1",
  model: "mock-gpt-4o",
  outputTokenField: "max_tokens",
  allowLocal: false,
};

export const sampleSnapshot: Snapshot = {
  protocolVersion: 1,
  constraints: sampleConstraints,
  evidence: sampleEvidence,
  models: {
    explorer: sampleModelConfig,
    literature: sampleModelConfig,
    feasibility: sampleModelConfig,
    moderator: sampleModelConfig,
  },
  budget: {
    maxRequests: 6,
    maxInputBytes: 96000,
    maxOutputTokens: 3000,
    requestTimeoutMs: 30000,
    maxDurationMs: 120000,
  },
};

export const sampleExploreOutput: ExploreOutput = {
  candidates: [
    {
      id: "cand-1",
      title: "推测采样在多智能体辩论中的通信开销压缩",
      question:
        "如何在单卡 4090 约束下，利用草稿模型推测采样降低多 Agent 辩论的推理延迟？",
      rationale:
        "结合文献 1 的推测采样与文献 2 的多 Agent 辩论，解决资源受限下的时延瓶颈。",
      claims: [
        {
          kind: "fact",
          text: "推测采样可在不改变输出分布的前提下实现 2-3 倍加速",
          citations: [
            { evidenceId: "ev-1", quote: "Speculative decoding achieves 2-3x speedup" },
          ],
        },
        {
          kind: "proposal",
          text: "针对 Agent 交互中的多轮提问构建轻量 Draft 缓存",
          citations: [],
        },
      ],
    },
    {
      id: "cand-2",
      title: "受限算力下多智能体思维链分歧最小化探索",
      question: "单卡 24G 显存下如何平衡辩论轮数与幻觉抑制效果？",
      rationale: "多 Agent 辩论往往需要大量上下文，需探索最优停止判定机制。",
      claims: [
        {
          kind: "fact",
          text: "迭代多智能体辩论能有效减少复杂推理任务中的幻觉",
          citations: [
            {
              evidenceId: "ev-2",
              quote: "Iterative multi-agent debate reduces hallucinations",
            },
          ],
        },
      ],
    },
  ],
};

export const sampleLitReviewOutput: ReviewOutput = {
  reviews: [
    {
      candidateId: "cand-1",
      assessment: "文献支持良好，推测采样在长上下文辩论中的草稿命中率有待验证。",
      objections: [
        "现有推测采样主要针对单一序列，多智能体分支对话状态可能导致草稿树分支爆炸",
      ],
      unknowns: ["多智能体共享 KV Cache 是否会导致上下文冲突"],
      claims: [
        {
          kind: "inference",
          text: "草稿模型预测多 Agent 互动时的接受率可能低于单模型生成",
          citations: [],
        },
      ],
    },
    {
      candidateId: "cand-2",
      assessment: "已有研究侧重于多轮收敛，缺乏对显存受限场景下的剪枝探索。",
      objections: ["24G 显存可能不足以支持多个 7B 以上模型同时加载"],
      unknowns: ["小模型（1B/3B）辩论是否仍具备幻觉抑制能力"],
      claims: [],
    },
  ],
};

export const sampleFeasReviewOutput: ReviewOutput = {
  reviews: [
    {
      candidateId: "cand-1",
      assessment: "工程可行性高，可在 vLLM 或 SGLang 现有推测采样实现上进行二次开发。",
      objections: [
        "4090 单卡显存仅 24GB，若同时驻留目标模型与草稿模型，批量大小严重受限",
      ],
      unknowns: ["量化版草稿模型对加速比的影响"],
      claims: [],
    },
    {
      candidateId: "cand-2",
      assessment: "实验周期约 3-4 周，数据集可直接采用 GSM8K / HumanEval。",
      objections: ["需要大量基准对比实验，单卡评测时间较长"],
      unknowns: ["开源量化推理框架对辩论流程的兼容性"],
      claims: [],
    },
  ],
};

export const sampleLitChallengeOutput: ReviewOutput = {
  reviews: [
    {
      candidateId: "cand-1",
      assessment:
        "针对可行性提出的显存瓶颈，文献中已有采用 4-bit 量化草稿模型的前例，可释放 4-6GB 显存。",
      objections: ["需评估量化误差对草稿接受率的负向传导"],
      unknowns: ["特定专业领域的词表不匹配问题"],
      claims: [],
    },
    {
      candidateId: "cand-2",
      assessment: "GSM8K 评测已过于饱和，建议补充近期更严格的 MATH-500 测试集。",
      objections: ["评测集若太难，小模型辩论可能均无法解出，无法区分差异"],
      unknowns: ["最新测试集上的真实表现"],
      claims: [],
    },
  ],
};

export const sampleFeasChallengeOutput: ReviewOutput = {
  reviews: [
    {
      candidateId: "cand-1",
      assessment:
        "接受 4-bit 草稿模型方案，在 4090 上可加载 7B-AWQ (4GB) + 1.5B (2GB)，显存占用完全可控在 16GB 以内。",
      objections: ["AWQ 内核调优需要一定 CUDA 工程时间，需预留 2 周调试"],
      unknowns: ["PagedAttention 对树状草稿验证的支持程度"],
      claims: [],
    },
    {
      candidateId: "cand-2",
      assessment:
        "若增加 MATH-500，单次全量评测耗时约 48 小时，可通过分层抽样 100 题做快速验证。",
      objections: ["抽样可能降低统计显著性"],
      unknowns: ["小样本评测与全量评测的一致性相关系数"],
      claims: [],
    },
  ],
};

export const sampleSynthesisOutput: SynthesisOutput = {
  cards: [
    {
      candidateId: "cand-1",
      title: "单卡 4090 下基于量化草稿推测采样的多 Agent 辩论推理加速",
      question: "如何在 24GB 显存内实现推测采样与多 Agent 对话状态共享的高效协同？",
      motivation:
        "多 Agent 辩论能显著降低幻觉但延迟成倍增加，解决单卡加速对轻量落地具有重大价值。",
      claims: [
        {
          kind: "fact",
          text: "推测采样在保持分布一致性下具备 2-3x 加速潜力",
          citations: [
            { evidenceId: "ev-1", quote: "Speculative decoding achieves 2-3x speedup" },
          ],
        },
      ],
      differences:
        "区别于传统单一序列推测采样，针对多智能体轮替发言的会话树设计特化草稿缓存。",
      resources: "RTX 4090 (24GB), Python 3.11, vLLM / SGLang, 预训练 7B+1.5B 模型",
      minimumExperiment:
        "在单卡上搭建 7B-INT4 主模型与 1.5B 草稿模型，测试 3 轮辩论的端到端延迟与加速比。",
      stopConditions: [
        "若量化草稿模型在辩论场景下的接受率低于 40%",
        "若树状草稿验证的显存管理开销超过加速节省的时间",
      ],
      disagreements: [
        "文献审查认为树状分支会引起草稿命中率雪崩，可行性审查认为可通过轮换线性草稿绕过",
      ],
      nextSteps: [
        "搭建 vLLM 离线推测采样基线脚本",
        "测量 1.5B 草稿模型在多智能体提示词下的实际接受率",
      ],
    },
    {
      candidateId: "cand-2",
      title: "显存受限下小模型多智能体辩论幻觉抑制的临界轮数研究",
      question:
        "在不超过 24GB 显存的算力边界下，小规模模型辩论在第几轮达到幻觉抑制与资源消耗的最优帕累托前沿？",
      motivation: "探索小模型能否通过结构化辩论获得超越单一大模型的推理鲁棒性。",
      claims: [
        {
          kind: "fact",
          text: "多 Agent 辩论可降低复杂推理任务中的幻觉",
          citations: [
            {
              evidenceId: "ev-2",
              quote: "Iterative multi-agent debate reduces hallucinations",
            },
          ],
        },
      ],
      differences:
        "不追求无穷迭代，通过设定确定性停止条件量化小模型辩论边际收益递减规律。",
      resources: "RTX 4090, GSM8K 抽样集与 MATH-500，3B/7B 开源模型",
      minimumExperiment:
        "在 100 道 GSM8K 难题上对比 1-5 轮辩论的准确率与单卡耗时曲线。",
      stopConditions: [
        "若 3 轮以上辩论准确率提升小于 1% 且方差过大",
        "若小模型在第 2 轮即出现同质化互相附和",
      ],
      disagreements: [
        "文献审查担心评测集太难导致完全无法区分，可行性审查倾向于分层抽样控制时间",
      ],
      nextSteps: [
        "选取 100 道 GSM8K 中等难度题目作为固定验证集",
        "实现简单的两人辩论提示词评测流",
      ],
    },
  ],
};
