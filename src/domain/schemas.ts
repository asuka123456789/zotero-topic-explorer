import { ExplorerError } from "./errors.ts";
import { hashText, utf8ByteLength } from "./hash.ts";
import type {
  Candidate,
  CardContent,
  Citation,
  Claim,
  Evidence,
  ExploreOutput,
  Review,
  ReviewOutput,
  StepName,
  StepOutput,
  SynthesisOutput,
} from "./types.ts";

const MAX_RAW_BYTES = 512 * 1024;
const MAX_TEXT = 12_000;
const MAX_SHORT_TEXT = 1_000;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function invalid(path: string, message: string): never {
  throw new ExplorerError("INVALID_MODEL_OUTPUT", `${path}：${message}`);
}

function asRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "必须是对象");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    return invalid(path, `包含未知字段 ${unknown.join("、")}`);
  }
  return record;
}

function asArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    return invalid(path, "必须是数组");
  }
  if (value.length < minimum || value.length > maximum) {
    return invalid(path, `数量必须在 ${minimum}–${maximum} 之间`);
  }
  return value;
}

function asString(value: unknown, path: string, maximum = MAX_TEXT): string {
  if (typeof value !== "string") {
    return invalid(path, "必须是字符串");
  }
  const text = value.trim();
  if (!text) {
    return invalid(path, "不能为空");
  }
  if (text.length > maximum) {
    return invalid(path, `长度不能超过 ${maximum} 个字符`);
  }
  return text;
}

function asID(value: unknown, path: string): string {
  const id = asString(value, path, 64);
  if (!SAFE_ID.test(id)) {
    return invalid(path, "格式无效");
  }
  return id;
}

function asStringArray(value: unknown, path: string, maximumItems = 12): string[] {
  return asArray(value, path, 0, maximumItems).map((entry, index) =>
    asString(entry, `${path}[${index}]`, MAX_SHORT_TEXT),
  );
}

function evidenceIndex(evidence: Evidence[]): Map<string, Evidence> {
  const result = new Map<string, Evidence>();
  for (const item of evidence) {
    if (result.has(item.id)) {
      throw new ExplorerError("INVALID_EVIDENCE", `证据 ID ${item.id} 重复`);
    }
    result.set(item.id, item);
  }
  return result;
}

function validateCitation(
  value: unknown,
  evidence: Map<string, Evidence>,
  path: string,
): Citation {
  // 真实模型偶尔把 evidenceId 写成 id；这是确定的同义字段，本地接受，不额外请求模型修复。
  const record = asRecord(value, path, ["evidenceId", "quote", "id"]);
  if (
    record.evidenceId !== undefined &&
    record.id !== undefined &&
    record.evidenceId !== record.id
  ) {
    return invalid(path, "evidenceId 与 id 不一致");
  }
  const evidenceId = asID(record.evidenceId ?? record.id, `${path}.evidenceId`);
  const quote = asString(record.quote, `${path}.quote`, 4_000);
  const source = evidence.get(evidenceId);
  if (!source) {
    return invalid(`${path}.evidenceId`, `未知证据 ${evidenceId}`);
  }
  if (!source.text.includes(quote)) {
    return invalid(`${path}.quote`, `引文未在证据 ${evidenceId} 中逐字出现`);
  }
  return { evidenceId, quote };
}

function validateClaim(
  value: unknown,
  evidence: Map<string, Evidence>,
  path: string,
): Claim {
  const record = asRecord(value, path, ["kind", "text", "citations"]);
  if (
    record.kind !== "fact" &&
    record.kind !== "inference" &&
    record.kind !== "proposal"
  ) {
    return invalid(`${path}.kind`, "必须是 fact、inference 或 proposal");
  }
  const citations = asArray(record.citations, `${path}.citations`, 0, 12).map(
    (entry, index) => validateCitation(entry, evidence, `${path}.citations[${index}]`),
  );
  if (record.kind === "fact" && citations.length === 0) {
    return invalid(`${path}.citations`, "fact 必须至少包含一条可核验引用");
  }
  const seen = new Set<string>();
  for (const citation of citations) {
    const key = JSON.stringify([citation.evidenceId, citation.quote]);
    if (seen.has(key)) {
      return invalid(`${path}.citations`, "不能包含重复引用");
    }
    seen.add(key);
  }
  return {
    kind: record.kind,
    text: asString(record.text, `${path}.text`),
    citations,
  };
}

function validateCandidate(
  value: unknown,
  evidence: Map<string, Evidence>,
  path: string,
): Candidate {
  const record = asRecord(value, path, [
    "id",
    "title",
    "question",
    "rationale",
    "claims",
  ]);
  return {
    id: asID(record.id, `${path}.id`),
    title: asString(record.title, `${path}.title`, 300),
    question: asString(record.question, `${path}.question`, 2_000),
    rationale: asString(record.rationale, `${path}.rationale`, 4_000),
    claims: asArray(record.claims, `${path}.claims`, 0, 12).map((entry, index) =>
      validateClaim(entry, evidence, `${path}.claims[${index}]`),
    ),
  };
}

function validateReview(
  value: unknown,
  evidence: Map<string, Evidence>,
  path: string,
): Review {
  const record = asRecord(value, path, [
    "candidateId",
    "assessment",
    "claims",
    "objections",
    "unknowns",
  ]);
  return {
    candidateId: asID(record.candidateId, `${path}.candidateId`),
    assessment: asString(record.assessment, `${path}.assessment`, 6_000),
    claims: asArray(record.claims, `${path}.claims`, 0, 12).map((entry, index) =>
      validateClaim(entry, evidence, `${path}.claims[${index}]`),
    ),
    objections: asStringArray(record.objections, `${path}.objections`),
    unknowns: asStringArray(record.unknowns, `${path}.unknowns`),
  };
}

function validateCard(
  value: unknown,
  evidence: Map<string, Evidence>,
  path: string,
): CardContent {
  const record = asRecord(value, path, [
    "candidateId",
    "title",
    "question",
    "motivation",
    "claims",
    "differences",
    "resources",
    "minimumExperiment",
    "stopConditions",
    "disagreements",
    "nextSteps",
  ]);
  return {
    candidateId: asID(record.candidateId, `${path}.candidateId`),
    title: asString(record.title, `${path}.title`, 300),
    question: asString(record.question, `${path}.question`, 2_000),
    motivation: asString(record.motivation, `${path}.motivation`, 6_000),
    claims: asArray(record.claims, `${path}.claims`, 0, 16).map((entry, index) =>
      validateClaim(entry, evidence, `${path}.claims[${index}]`),
    ),
    differences: asString(record.differences, `${path}.differences`, 6_000),
    resources: asString(record.resources, `${path}.resources`, 6_000),
    minimumExperiment: asString(
      record.minimumExperiment,
      `${path}.minimumExperiment`,
      6_000,
    ),
    stopConditions: asStringArray(record.stopConditions, `${path}.stopConditions`),
    disagreements: asStringArray(record.disagreements, `${path}.disagreements`),
    nextSteps: asStringArray(record.nextSteps, `${path}.nextSteps`),
  };
}

function assertUniqueIDs(ids: string[], path: string): void {
  if (new Set(ids).size !== ids.length) {
    invalid(path, "ID 必须唯一");
  }
}

function assertCandidateCoverage(
  ids: string[],
  expected: string[] | undefined,
  path: string,
): void {
  assertUniqueIDs(ids, path);
  if (!expected) {
    return;
  }
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length) {
    throw new ExplorerError("INVALID_CANDIDATES", "候选题 ID 列表包含重复值");
  }
  const unknown = ids.filter((id) => !expectedSet.has(id));
  const missing = expected.filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    invalid(path, `包含未知候选题 ${unknown.join("、")}`);
  }
  if (missing.length > 0) {
    invalid(path, `缺少候选题 ${missing.join("、")}`);
  }
}

export function validateEvidenceSet(evidence: Evidence[]): void {
  if (evidence.length === 0 || evidence.length > 200) {
    throw new ExplorerError("INVALID_EVIDENCE", "证据数量必须在 1–200 之间");
  }
  const ids = new Set<string>();
  for (const [index, item] of evidence.entries()) {
    const path = `evidence[${index}]`;
    if (!SAFE_ID.test(item.id)) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path}.id 格式无效`);
    }
    if (ids.has(item.id)) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path}.id 重复`);
    }
    ids.add(item.id);
    if (!item.text.trim()) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path}.text 不能为空`);
    }
    if (item.hash !== hashText(item.text)) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path}.hash 与文本不一致`);
    }
    if (item.pageLabel !== undefined && !item.pageLabel.trim()) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path}.pageLabel 不能为空`);
    }
    if ((item.start === undefined) !== (item.end === undefined)) {
      throw new ExplorerError(
        "INVALID_EVIDENCE",
        `${path} 的字符范围必须同时包含 start 和 end`,
      );
    }
    if (
      item.start !== undefined &&
      item.end !== undefined &&
      (!Number.isInteger(item.start) ||
        !Number.isInteger(item.end) ||
        item.start < 0 ||
        item.end <= item.start)
    ) {
      throw new ExplorerError("INVALID_EVIDENCE", `${path} 的字符范围无效`);
    }
  }
}

/** 本地去掉模型常见的 ```json 围栏；不发起任何额外请求。 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function validateStepOutput(
  name: StepName,
  raw: string,
  evidence: Evidence[],
  candidateIds?: string[],
): StepOutput {
  if (utf8ByteLength(raw) > MAX_RAW_BYTES) {
    throw new ExplorerError("MODEL_OUTPUT_TOO_LARGE", "模型输出超过本地校验上限");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ExplorerError("INVALID_MODEL_JSON", "模型返回的内容不是有效 JSON");
  }
  const sources = evidenceIndex(evidence);

  if (name === "explore") {
    const record = asRecord(parsed, "output", ["candidates"]);
    const candidates = asArray(record.candidates, "output.candidates", 2, 3).map(
      (entry, index) =>
        validateCandidate(entry, sources, `output.candidates[${index}]`),
    );
    assertUniqueIDs(
      candidates.map((candidate) => candidate.id),
      "output.candidates",
    );
    return { candidates } satisfies ExploreOutput;
  }

  if (name === "synthesize") {
    const record = asRecord(parsed, "output", ["cards"]);
    const maximum = candidateIds?.length ?? 3;
    const cards = asArray(record.cards, "output.cards", 1, maximum).map(
      (entry, index) => validateCard(entry, sources, `output.cards[${index}]`),
    );
    assertCandidateCoverage(
      cards.map((card) => card.candidateId),
      candidateIds,
      "output.cards",
    );
    return { cards } satisfies SynthesisOutput;
  }

  const record = asRecord(parsed, "output", ["reviews"]);
  const maximum = candidateIds?.length ?? 3;
  const reviews = asArray(record.reviews, "output.reviews", 1, maximum).map(
    (entry, index) => validateReview(entry, sources, `output.reviews[${index}]`),
  );
  assertCandidateCoverage(
    reviews.map((review) => review.candidateId),
    candidateIds,
    "output.reviews",
  );
  return { reviews } satisfies ReviewOutput;
}
