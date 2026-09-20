import { expect } from "chai";
import { hashText } from "../../src/domain/hash.ts";
import {
  renderProjectMarkdown,
  renderTopicCardMarkdown,
} from "../../src/export/markdown.ts";
import type { Evidence, Project, TopicCard } from "../../src/domain/types.ts";

const evidenceText = "结果显示该方案可在两周内完成最小验证。";
const evidence: Evidence = {
  id: "E1",
  libraryID: 1,
  itemKey: "TEST1234",
  kind: "manual",
  title: "<script>不可信标题</script>",
  text: evidenceText,
  hash: hashText(evidenceText),
  extraction: "manual",
  pageLabel: "附录 A",
  truncated: false,
};

const card: TopicCard = {
  id: "card-1",
  projectId: "project-1",
  runId: "run-1",
  generated: {
    candidateId: "C1",
    title: "方向 [链接](https://example.com)",
    question: "是否值得做？",
    motivation: "从已有材料做最小验证。",
    claims: [
      {
        kind: "fact",
        text: "方案可在两周内验证。",
        citations: [
          {
            evidenceId: "E1",
            quote: "可在两周内完成最小验证",
          },
        ],
      },
    ],
    differences: "尚未完成全网查新。",
    resources: "本地算力。",
    minimumExperiment: "完成一个基线。",
    stopConditions: ["基线不可复现"],
    disagreements: ["数据规模是否足够"],
    nextSteps: ["核查原始论文"],
  },
  status: "exploring",
  notes: "# 不应变成标题",
  revision: 2,
  needsReview: true,
  createdAt: 1,
  updatedAt: 1,
};

const project: Project = {
  id: "project-1",
  name: "测试项目",
  constraints: {
    interests: "通用方法",
    background: "未知",
    time: "两周",
    compute: "本地 GPU",
    data: "公开数据",
  },
  evidence: [evidence],
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("Markdown 导出", function () {
  it("保留来源声明并转义不可信 Markdown 与 HTML", function () {
    const output = renderTopicCardMarkdown(card, [evidence]);
    expect(output).to.include("仅基于所选资料，未完成全网查新");
    expect(output).to.include("需要复核引用与论断");
    expect(output).to.include("方向 \\[链接\\]\\(https://example.com\\)");
    expect(output).to.include("&lt;script&gt;不可信标题&lt;/script&gt;");
    expect(output).to.include("页码/位置：附录 A");
    expect(output).to.include("\\# 不应变成标题");
    expect(output).not.to.include("<script>");
  });

  it("项目导出只包含所属项目的卡片", function () {
    const other = { ...card, id: "card-2", projectId: "other" };
    const output = renderProjectMarkdown(project, [card, other], {
      incomplete: true,
    });
    expect(output.match(/候选题 ID/g)).to.have.length(1);
    expect(output).to.include("不完整草稿");
  });
});
