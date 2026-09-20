import type {
  CardContent,
  Claim,
  Evidence,
  Project,
  Review,
  Run,
  StepName,
  TopicCard,
} from "../domain/types.ts";

export interface MarkdownOptions {
  incomplete?: boolean;
  includeGeneratedVersion?: boolean;
}

const STATUS_LABELS: Record<TopicCard["status"], string> = {
  exploring: "继续探索",
  experiment: "准备试验",
  paused: "暂缓",
  discarded: "放弃",
};

function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()])/g, "\\$1")
    .replace(/^(\s*)(#{1,6}|[-+]|\d+[.)])\s/gm, "$1\\$2 ");
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body || "未填写"}`;
}

function list(values: string[]): string {
  return values.length > 0
    ? values.map((value) => `- ${escapeMarkdown(value)}`).join("\n")
    : "- 无";
}

function renderClaims(claims: Claim[]): string {
  if (claims.length === 0) {
    return "- 无";
  }
  return claims
    .map((claim) => {
      const citations = claim.citations
        .map((citation) => `[${escapeMarkdown(citation.evidenceId)}]`)
        .join(" ");
      const suffix = citations ? ` ${citations}` : "";
      return `- **${claim.kind}**：${escapeMarkdown(claim.text)}${suffix}`;
    })
    .join("\n");
}

function referencedEvidence(content: CardContent, evidence: Evidence[]): Evidence[] {
  const ids = new Set(
    content.claims.flatMap((claim) =>
      claim.citations.map((citation) => citation.evidenceId),
    ),
  );
  return evidence.filter((item) => ids.has(item.id));
}

function renderSources(content: CardContent, evidence: Evidence[]): string {
  const index = new Map(evidence.map((item) => [item.id, item]));
  const quoteLines = content.claims.flatMap((claim) =>
    claim.citations.map((citation) => {
      const source = index.get(citation.evidenceId);
      const locator = source?.pageLabel
        ? `，页码/位置：${escapeMarkdown(source.pageLabel)}`
        : source?.start !== undefined && source.end !== undefined
          ? `，字符范围：${source.start}–${source.end}`
          : "";
      return `> “${escapeMarkdown(citation.quote).replace(/\n/g, "\n> ")}” — [${escapeMarkdown(citation.evidenceId)}]${locator}`;
    }),
  );
  const sources = referencedEvidence(content, evidence).map((item) => {
    const attachment = item.attachmentKey
      ? `，附件 ${escapeMarkdown(item.attachmentKey)}`
      : "";
    const annotation = item.annotationKey
      ? `，批注 ${escapeMarkdown(item.annotationKey)}`
      : "";
    return `- [${escapeMarkdown(item.id)}] ${escapeMarkdown(item.title)}（${escapeMarkdown(item.kind)}；Zotero ${item.libraryID}:${escapeMarkdown(item.itemKey)}${attachment}${annotation}）`;
  });
  if (sources.length === 0 && quoteLines.length === 0) {
    return "- 无已引用来源";
  }
  return [...sources, "", ...quoteLines].join("\n").trim();
}

function renderContent(content: CardContent, evidence: Evidence[]): string {
  return [
    section("研究问题", escapeMarkdown(content.question)),
    section("动机", escapeMarkdown(content.motivation)),
    section("证据与论断", renderClaims(content.claims)),
    section("与已有工作的区别", escapeMarkdown(content.differences)),
    section("资源要求", escapeMarkdown(content.resources)),
    section("最小验证实验", escapeMarkdown(content.minimumExperiment)),
    section("停止条件", list(content.stopConditions)),
    section("未解决分歧", list(content.disagreements)),
    section("下一步", list(content.nextSteps)),
    section("来源", renderSources(content, evidence)),
  ].join("\n\n");
}

export function renderTopicCardMarkdown(
  card: TopicCard,
  evidence: Evidence[],
  options: MarkdownOptions = {},
): string {
  const content = card.edited ?? card.generated;
  const notices = ["仅基于所选资料，未完成全网查新。"];
  if (options.incomplete) {
    notices.push("本次讨论未完整结束；以下内容是不完整草稿。");
  }
  if (card.needsReview) {
    notices.push("卡片含人工编辑或未重新核验内容，需要复核引用与论断。");
  }
  const blocks = [
    `# ${escapeMarkdown(content.title)}`,
    notices.map((notice) => `> ${notice}`).join("\n>\n"),
    `- 状态：${STATUS_LABELS[card.status]}\n- 候选题 ID：${escapeMarkdown(content.candidateId)}\n- 修订号：${card.revision}`,
    renderContent(content, evidence),
    section("用户备注", card.notes ? escapeMarkdown(card.notes) : "无"),
  ];
  if (options.includeGeneratedVersion && card.edited) {
    blocks.push("---", "# AI 原始版本", renderContent(card.generated, evidence));
  }
  return `${blocks.join("\n\n")}\n`;
}

export function renderProjectMarkdown(
  project: Project,
  cards: TopicCard[],
  options: MarkdownOptions = {},
): string {
  const constraints = project.constraints;
  const header = [
    `# ${escapeMarkdown(project.name)}`,
    "> 仅基于所选资料，未完成全网查新。",
    section(
      "研究约束",
      [
        `- 兴趣：${escapeMarkdown(constraints.interests || "未知")}`,
        `- 已有基础：${escapeMarkdown(constraints.background || "未知")}`,
        `- 时间：${escapeMarkdown(constraints.time || "未知")}`,
        `- 算力：${escapeMarkdown(constraints.compute || "未知")}`,
        `- 数据：${escapeMarkdown(constraints.data || "未知")}`,
      ].join("\n"),
    ),
  ].join("\n\n");
  const body = cards
    .filter((card) => card.projectId === project.id)
    .map((card) =>
      renderTopicCardMarkdown(card, project.evidence, options).replace(/^# /, "## "),
    )
    .join("\n\n---\n\n");
  return `${header}\n\n${body || "## 选题卡片\n\n暂无卡片。\n"}`;
}

export const STEP_LABELS: Record<StepName, string> = {
  explore: "探索：候选问题",
  literature: "文献审查（初审）",
  feasibility: "可行性评估（初审）",
  literature_challenge: "文献审查：针对可行性意见的质疑",
  feasibility_challenge: "可行性评估：针对文献意见的质疑",
  synthesize: "主控汇总",
};

export const RUN_STATE_LABELS: Record<Run["state"], string> = {
  awaiting_confirmation: "待确认",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

function renderReviews(reviews: Review[]): string {
  return reviews
    .map((review) =>
      [
        `### 候选题 ${escapeMarkdown(review.candidateId)}`,
        escapeMarkdown(review.assessment),
        `**论断**\n\n${renderClaims(review.claims)}`,
        `**异议**\n\n${list(review.objections)}`,
        `**待检索问题**\n\n${list(review.unknowns)}`,
      ].join("\n\n"),
    )
    .join("\n\n");
}

/** 讨论未完整结束时导出的阶段结果草稿；标题固定标明“不完整”。 */
export function renderRunDraftMarkdown(run: Run, projectName: string): string {
  const blocks = [
    `# ${escapeMarkdown(projectName)}：讨论草稿（不完整）`,
    `> 本次讨论状态：${RUN_STATE_LABELS[run.state]}；已发送请求 ${run.requestsUsed}/${run.snapshot.budget.maxRequests}。以下仅为已完成阶段的结果，不是最终选题卡片。\n>\n> 仅基于所选资料，未完成全网查新。`,
  ];
  if (run.error) {
    blocks.push(
      `> 错误：${escapeMarkdown(run.error.code)} — ${escapeMarkdown(run.error.message)}`,
    );
  }
  for (const step of run.steps) {
    const output = step.output;
    if (!output) {
      blocks.push(`## ${STEP_LABELS[step.name]}\n\n未完成（状态：${step.state}）。`);
      continue;
    }
    if ("candidates" in output) {
      blocks.push(
        `## ${STEP_LABELS[step.name]}\n\n${output.candidates
          .map((candidate) =>
            [
              `### ${escapeMarkdown(candidate.id)}：${escapeMarkdown(candidate.title)}`,
              `**研究问题**：${escapeMarkdown(candidate.question)}`,
              `**理由**：${escapeMarkdown(candidate.rationale)}`,
              renderClaims(candidate.claims),
            ].join("\n\n"),
          )
          .join("\n\n")}`,
      );
    } else if ("reviews" in output) {
      blocks.push(`## ${STEP_LABELS[step.name]}\n\n${renderReviews(output.reviews)}`);
    } else {
      blocks.push(
        `## ${STEP_LABELS[step.name]}\n\n${output.cards
          .map((card) => renderContent(card, run.snapshot.evidence))
          .join("\n\n---\n\n")}`,
      );
    }
  }
  return `${blocks.join("\n\n")}\n`;
}
