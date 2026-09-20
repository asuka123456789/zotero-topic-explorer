import { expect } from "chai";
import {
  hashText,
  snapshotFingerprint,
  utf8ByteLength,
} from "../../src/domain/hash.ts";
import { validateEvidenceSet, validateStepOutput } from "../../src/domain/schemas.ts";
import type { Evidence, Snapshot } from "../../src/domain/types.ts";

function source(text = "该研究在公开数据集上报告了明确改进。"): Evidence {
  return {
    id: "E1",
    libraryID: 1,
    itemKey: "ABC12345",
    kind: "abstract",
    title: "合成测试文献",
    text,
    hash: hashText(text),
    extraction: "metadata",
    truncated: false,
  };
}

function candidate(id = "C1") {
  return {
    id,
    title: "候选方向",
    question: "这个方法是否值得验证？",
    rationale: "资料给出了可检验线索。",
    claims: [
      {
        kind: "fact",
        text: "文献报告了改进。",
        citations: [
          {
            evidenceId: "E1",
            quote: "在公开数据集上报告了明确改进",
          },
        ],
      },
    ],
  };
}

describe("领域哈希与结构化输出校验", function () {
  it("计算稳定 SHA-256 和 UTF-8 字节数", function () {
    expect(hashText("abc")).to.equal(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(utf8ByteLength("选题")).to.equal(6);
  });

  it("对象键顺序不影响快照指纹", function () {
    const model = {
      id: "m",
      label: "mock",
      baseURL: "https://example.invalid/v1",
      model: "mock",
      outputTokenField: "max_tokens" as const,
      allowLocal: false,
    };
    const first: Snapshot = {
      protocolVersion: 1,
      constraints: {
        interests: "a",
        background: "b",
        time: "c",
        compute: "d",
        data: "e",
      },
      evidence: [source()],
      models: {
        explorer: model,
        literature: model,
        feasibility: model,
        moderator: model,
      },
      budget: {
        maxRequests: 6,
        maxInputBytes: 96_000,
        maxOutputTokens: 3_000,
        requestTimeoutMs: 120_000,
        maxDurationMs: 600_000,
      },
    };
    const reordered = JSON.parse(JSON.stringify(first)) as Snapshot;
    reordered.constraints = {
      data: "e",
      compute: "d",
      time: "c",
      background: "b",
      interests: "a",
    };
    expect(snapshotFingerprint(first)).to.equal(snapshotFingerprint(reordered));
  });

  it("接受带逐字引用的候选题", function () {
    const result = validateStepOutput(
      "explore",
      JSON.stringify({ candidates: [candidate("C1"), candidate("C2")] }),
      [source()],
    );
    expect("candidates" in result && result.candidates).to.have.length(2);
  });

  it("本地去掉 ```json 围栏后仍按严格 JSON 校验", function () {
    const body = JSON.stringify({ candidates: [candidate("C1"), candidate("C2")] });
    const result = validateStepOutput("explore", `\`\`\`json\n${body}\n\`\`\``, [
      source(),
    ]);
    expect("candidates" in result && result.candidates).to.have.length(2);
    expect(() =>
      validateStepOutput("explore", "```json\n{ broken\n```", [source()]),
    ).to.throw("不是有效 JSON");
  });

  it("拒绝未知证据、伪造引文和额外定位字段", function () {
    const unknown = candidate("C1");
    unknown.claims[0].citations[0].evidenceId = "E9";
    expect(() =>
      validateStepOutput(
        "explore",
        JSON.stringify({ candidates: [unknown, candidate("C2")] }),
        [source()],
      ),
    ).to.throw("未知证据");

    const fakeQuote = candidate("C1");
    fakeQuote.claims[0].citations[0].quote = "并不存在的逐字引文";
    expect(() =>
      validateStepOutput(
        "explore",
        JSON.stringify({ candidates: [fakeQuote, candidate("C2")] }),
        [source()],
      ),
    ).to.throw("逐字出现");

    const fakePage = candidate("C1") as ReturnType<typeof candidate> & {
      pageLabel?: string;
    };
    fakePage.pageLabel = "42";
    expect(() =>
      validateStepOutput(
        "explore",
        JSON.stringify({ candidates: [fakePage, candidate("C2")] }),
        [source()],
      ),
    ).to.throw("未知字段");
  });

  it("接受 citations 里的 id 同义字段，但拒绝与 evidenceId 冲突", function () {
    const aliased = candidate("C1") as unknown as {
      claims: Array<{ citations: Array<Record<string, string>> }>;
    };
    const citation = aliased.claims[0].citations[0];
    aliased.claims[0].citations[0] = { id: citation.evidenceId, quote: citation.quote };
    const result = validateStepOutput(
      "explore",
      JSON.stringify({ candidates: [aliased, candidate("C2")] }),
      [source()],
    );
    expect(
      "candidates" in result && result.candidates[0].claims[0].citations[0].evidenceId,
    ).to.equal("E1");

    aliased.claims[0].citations[0] = {
      id: "E1",
      evidenceId: "E2",
      quote: citation.quote,
    };
    expect(() =>
      validateStepOutput(
        "explore",
        JSON.stringify({ candidates: [aliased, candidate("C2")] }),
        [source()],
      ),
    ).to.throw("不一致");
  });

  it("要求所有评审覆盖冻结的候选题", function () {
    const review = {
      candidateId: "C1",
      assessment: "仍需验证。",
      claims: [],
      objections: ["样本有限"],
      unknowns: ["缺少外部查新"],
    };
    expect(() =>
      validateStepOutput(
        "literature",
        JSON.stringify({ reviews: [review] }),
        [source()],
        ["C1", "C2"],
      ),
    ).to.throw("缺少候选题 C2");
  });

  it("验证证据内容哈希和真实字符范围", function () {
    const valid = source();
    valid.start = 20;
    valid.end = 30;
    expect(() => validateEvidenceSet([valid])).not.to.throw();
    valid.hash = "0".repeat(64);
    expect(() => validateEvidenceSet([valid])).to.throw("hash 与文本不一致");
  });
});
