import {
  type Candidate,
  type CardContent,
  type Evidence,
  type ExploreOutput,
  type Review,
  type ReviewOutput,
  type Snapshot,
  type StepName,
  type StepOutput,
  type SynthesisOutput,
} from "../../src/domain/types.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

export function mockHashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return `hash-${Math.abs(hash).toString(16)}`;
}

export function mockSnapshotFingerprint(snapshot: Snapshot): string {
  const stable = {
    protocolVersion: snapshot.protocolVersion,
    constraints: snapshot.constraints,
    evidence: snapshot.evidence.map((e) => ({ id: e.id, hash: e.hash })),
    models: snapshot.models,
    budget: snapshot.budget,
  };
  return `fp-${mockHashText(JSON.stringify(stable))}`;
}

export function mockValidateStepOutput(
  name: StepName,
  raw: string,
  evidence: Evidence[],
  candidateIds?: string[],
): StepOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExplorerError("SCHEMA_PARSE_ERROR", `步骤 ${name} 响应不是有效的 JSON`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ExplorerError(
      "SCHEMA_VALIDATION_ERROR",
      `步骤 ${name} 响应必须是 JSON 对象`,
    );
  }

  const validEvidenceIds = new Set(evidence.map((e) => e.id));
  const evidenceMap = new Map(evidence.map((e) => [e.id, e.text]));

  if (name === "explore") {
    const out = parsed as ExploreOutput;
    if (!Array.isArray(out.candidates) || out.candidates.length === 0) {
      throw new ExplorerError(
        "SCHEMA_VALIDATION_ERROR",
        "explore 必须输出 candidates 数组",
      );
    }
    for (const c of out.candidates) {
      if (!c.id || !c.title || !c.question) {
        throw new ExplorerError("SCHEMA_VALIDATION_ERROR", "candidate 缺少必需字段");
      }
      if (Array.isArray(c.claims)) {
        for (const cl of c.claims) {
          if (Array.isArray(cl.citations)) {
            for (const ci of cl.citations) {
              if (!validEvidenceIds.has(ci.evidenceId)) {
                throw new ExplorerError(
                  "FAKE_CITATION",
                  `引用了不存在的证据编号: ${ci.evidenceId}`,
                );
              }
              const evText = evidenceMap.get(ci.evidenceId) || "";
              if (ci.quote && !evText.includes(ci.quote)) {
                throw new ExplorerError(
                  "FAKE_CITATION",
                  `引文 "${ci.quote}" 未在证据编号 ${ci.evidenceId} 中逐字找到`,
                );
              }
            }
          }
        }
      }
    }
    return out;
  }

  if (
    name === "literature" ||
    name === "feasibility" ||
    name === "literature_challenge" ||
    name === "feasibility_challenge"
  ) {
    const out = parsed as ReviewOutput;
    if (!Array.isArray(out.reviews)) {
      throw new ExplorerError(
        "SCHEMA_VALIDATION_ERROR",
        `${name} 必须输出 reviews 数组`,
      );
    }
    if (candidateIds) {
      const idsSet = new Set(candidateIds);
      for (const r of out.reviews) {
        if (!idsSet.has(r.candidateId)) {
          throw new ExplorerError(
            "SCHEMA_VALIDATION_ERROR",
            `评审包含未知的 candidateId: ${r.candidateId}`,
          );
        }
      }
    }
    return out;
  }

  if (name === "synthesize") {
    const out = parsed as SynthesisOutput;
    if (!Array.isArray(out.cards) || out.cards.length === 0) {
      throw new ExplorerError(
        "SCHEMA_VALIDATION_ERROR",
        "synthesize 必须输出 cards 数组",
      );
    }
    for (const card of out.cards) {
      if (!card.candidateId || !card.title || !card.question) {
        throw new ExplorerError("SCHEMA_VALIDATION_ERROR", "card 缺少必需字段");
      }
    }
    return out;
  }

  throw new ExplorerError("UNKNOWN_STEP", `未知步骤 ${name}`);
}
