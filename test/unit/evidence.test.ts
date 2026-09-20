import { expect } from "chai";
import {
  EXTRACTION,
  MAX_ANNOTATION_CHARS,
  MAX_FULLTEXT_CHARS,
  collectEvidence,
  collectOptionalEvidence,
  openSource,
  type ZoteroItemLike,
  type ZoteroRuntime,
} from "../../src/zotero/evidence.ts";
import { hashText } from "../../src/domain/hash.ts";
import { validateEvidenceSet } from "../../src/domain/schemas.ts";
import { ExplorerError } from "../../src/domain/errors.ts";
import type { Evidence, SelectionTarget } from "../../src/domain/types.ts";

interface FakeItemSpec {
  id: number;
  key: string;
  libraryID?: number;
  regular?: boolean;
  pdf?: boolean;
  deleted?: boolean;
  fields?: Record<string, string>;
  creators?: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
    fieldMode?: number;
  }>;
  attachments?: number[];
  annotations?: ZoteroItemLike[];
  parentItemKey?: string;
  filePath?: string;
}

function fakeItem(spec: FakeItemSpec): ZoteroItemLike & { filePath?: string } {
  const fields = spec.fields ?? {};
  return {
    id: spec.id,
    key: spec.key,
    libraryID: spec.libraryID ?? 1,
    deleted: spec.deleted ?? false,
    parentItemKey: spec.parentItemKey ?? false,
    filePath: spec.filePath,
    isRegularItem: () => spec.regular ?? !spec.pdf,
    isAttachment: () => spec.pdf === true || spec.regular === false,
    isFileAttachment: () => spec.pdf === true,
    isPDFAttachment: () => spec.pdf === true,
    getField: (name: string) => fields[name] ?? "",
    getExtraField: () => "",
    getDisplayTitle: () => fields.title ?? "",
    getCreators: () => spec.creators ?? [],
    getAttachments: () => spec.attachments ?? [],
    getAnnotations: () => spec.annotations ?? [],
  };
}

function fakeAnnotation(spec: {
  key: string;
  text?: string;
  comment?: string;
  pageLabel?: string;
  sortIndex?: string;
  deleted?: boolean;
}): ZoteroItemLike {
  return {
    id: 900 + spec.key.charCodeAt(0),
    key: spec.key,
    libraryID: 1,
    deleted: spec.deleted ?? false,
    isRegularItem: () => false,
    isAttachment: () => false,
    getField: () => "",
    annotationType: "highlight",
    annotationText: spec.text,
    annotationComment: spec.comment,
    annotationPageLabel: spec.pageLabel,
    annotationSortIndex: spec.sortIndex ?? "00000|000000|00000",
  };
}

interface FakeRuntimeOptions {
  items: ZoteroItemLike[];
  cache?: Record<string, string | null>;
  withFulltextApi?: boolean;
  fileSize?: number;
}

function fakeRuntime(options: FakeRuntimeOptions) {
  const byKey = new Map(
    options.items.map((item) => [`${item.libraryID}:${item.key}`, item]),
  );
  const byId = new Map(options.items.map((item) => [item.id, item]));
  const calls = {
    indexItems: 0,
    getContents: [] as unknown[],
    selectItem: [] as number[],
    readerOpen: [] as unknown[][],
  };
  const runtime: ZoteroRuntime = {
    Items: {
      async getByLibraryAndKeyAsync(libraryID: number, key: string) {
        return byKey.get(`${libraryID}:${key}`) ?? false;
      },
      get(id: number) {
        return byId.get(id) ?? false;
      },
    },
    Reader: {
      async open(...args: unknown[]) {
        calls.readerOpen.push(args);
      },
    },
    getActiveZoteroPane() {
      return {
        selectItem(itemID: number) {
          calls.selectItem.push(itemID);
          return true;
        },
      };
    },
  };
  if (options.withFulltextApi !== false) {
    const cache = options.cache ?? {};
    runtime.Fulltext = {
      getItemCacheFile(item) {
        const content = cache[item.key];
        return {
          exists: () => content !== undefined && content !== null,
          fileSize: options.fileSize,
          content,
        } as { exists(): boolean; fileSize?: number; content?: string | null };
      },
    };
    (runtime.Fulltext as unknown as { indexItems: () => void }).indexItems = () => {
      calls.indexItems += 1;
      throw new Error("indexing must never be triggered");
    };
    runtime.File = {
      async getContentsAsync(source, _charset, maxLength) {
        calls.getContents.push(source);
        const content = (source as { content?: string }).content ?? "";
        return maxLength ? content.slice(0, maxLength) : content;
      },
    };
  }
  return { runtime, calls };
}

function target(key: string, title = `Title ${key}`): SelectionTarget {
  return { libraryID: 1, itemKey: key, title };
}

function assertNoLocalPaths(evidence: Evidence[]): void {
  for (const item of evidence) {
    for (const forbidden of ["filePath", "path", "url", "id_", "attachmentPath"]) {
      expect(item).to.not.have.property(forbidden);
    }
    expect(JSON.stringify(item)).to.not.match(/[A-Z]:\\|\/storage\/|\/home\//u);
  }
}

describe("Zotero 证据采集与来源跳转", function () {
  describe("collectEvidence（默认只读题录 + 摘要）", function () {
    it("生成题录摘要与摘要证据，ID 稳定且 hash 与文本一致", async function () {
      const { runtime } = fakeRuntime({
        items: [
          fakeItem({
            id: 1,
            key: "AAAAAAAA",
            fields: {
              title: "对比学习综述",
              date: "2024-05-01",
              DOI: "10.1000/xyz123",
              abstractNote: "  本文综述了对比学习。\r\n第二段。  ",
            },
            creators: [
              { firstName: "Wei", lastName: "Zhang" },
              { name: "OpenAI Team", fieldMode: 1 },
            ],
            filePath: "C:\\Users\\secret\\storage\\AAAAAAAA\\paper.pdf",
          }),
        ],
      });

      const result = await collectEvidence([target("AAAAAAAA")], { zotero: runtime });

      expect(result.warnings).to.deep.equal([]);
      expect(result.evidence.map((e) => e.id)).to.deep.equal(["E1", "E2"]);
      const [metadata, abstract] = result.evidence;
      expect(metadata.kind).to.equal("metadata");
      expect(metadata.extraction).to.equal(EXTRACTION.metadata);
      expect(metadata.text).to.equal(
        "题名：对比学习综述\n作者：Wei Zhang; OpenAI Team\n日期：2024-05-01\nDOI：10.1000/xyz123",
      );
      expect(metadata.hash).to.equal(hashText(metadata.text));
      expect(metadata.truncated).to.equal(false);
      expect(metadata.libraryID).to.equal(1);
      expect(metadata.itemKey).to.equal("AAAAAAAA");
      expect(metadata.pageLabel).to.equal(undefined);

      expect(abstract.kind).to.equal("abstract");
      expect(abstract.extraction).to.equal(EXTRACTION.abstract);
      expect(abstract.text).to.equal("本文综述了对比学习。\n第二段。");
      expect(abstract.hash).to.equal(hashText(abstract.text));
      assertNoLocalPaths(result.evidence);
      expect(() => validateEvidenceSet(result.evidence)).to.not.throw();
    });

    it("缺摘要写入 warnings，而不是抛错；ID 在多篇文献间连续", async function () {
      const { runtime } = fakeRuntime({
        items: [
          fakeItem({
            id: 1,
            key: "AAAAAAAA",
            fields: { title: "有摘要", abstractNote: "摘要" },
          }),
          fakeItem({ id: 2, key: "BBBBBBBB", fields: { title: "无摘要" } }),
        ],
      });

      const result = await collectEvidence([target("AAAAAAAA"), target("BBBBBBBB")], {
        zotero: runtime,
      });

      expect(result.evidence.map((e) => e.id)).to.deep.equal(["E1", "E2", "E3"]);
      expect(result.evidence[2].kind).to.equal("metadata");
      expect(result.warnings).to.deep.equal(["《无摘要》没有摘要，仅提供题录信息"]);
    });

    it("支持 startIndex 以避免与已有证据的 ID 冲突", async function () {
      const { runtime } = fakeRuntime({
        items: [fakeItem({ id: 1, key: "AAAAAAAA", fields: { title: "T" } })],
      });
      const result = await collectEvidence([target("AAAAAAAA")], {
        zotero: runtime,
        startIndex: 7,
      });
      expect(result.evidence.map((e) => e.id)).to.deep.equal(["E7"]);
    });

    it("跳过不存在、已删除或非文献条目并写入 warnings", async function () {
      const { runtime } = fakeRuntime({
        items: [
          fakeItem({
            id: 1,
            key: "AAAAAAAA",
            deleted: true,
            fields: { title: "已删除" },
          }),
          fakeItem({
            id: 2,
            key: "CCCCCCCC",
            regular: false,
            fields: { title: "独立 ZIP" },
          }),
        ],
      });
      const result = await collectEvidence(
        [target("AAAAAAAA"), target("BBBBBBBB", "不存在"), target("CCCCCCCC")],
        { zotero: runtime },
      );
      expect(result.evidence).to.deep.equal([]);
      expect(result.warnings).to.deep.equal([
        "《已删除》已在回收站，已跳过",
        "《不存在》在文库中不存在，已跳过",
        "《独立 ZIP》不是文献条目或独立 PDF，已跳过",
      ]);
    });

    it("独立 PDF 可作为文献目标", async function () {
      const { runtime } = fakeRuntime({
        items: [
          fakeItem({
            id: 3,
            key: "DDDDDDDD",
            pdf: true,
            fields: { title: "独立 PDF" },
          }),
        ],
      });
      const result = await collectEvidence([target("DDDDDDDD")], { zotero: runtime });
      expect(result.evidence).to.have.lengthOf(1);
      expect(result.evidence[0].text).to.equal("题名：独立 PDF");
    });

    it("超过 20 篇直接拒绝，不静默截断；非法 key 拒绝", async function () {
      const { runtime } = fakeRuntime({ items: [] });
      const many = Array.from({ length: 21 }, (_, index) =>
        target(`K${String(index).padStart(7, "0")}`),
      );
      try {
        await collectEvidence(many, { zotero: runtime });
        expect.fail("应当抛出");
      } catch (error) {
        expect((error as ExplorerError).code).to.equal("SELECTION_LIMIT_EXCEEDED");
      }
      try {
        await collectEvidence([{ libraryID: 1, itemKey: "../etc", title: "x" }], {
          zotero: runtime,
        });
        expect.fail("应当抛出");
      } catch (error) {
        expect((error as ExplorerError).code).to.equal("INVALID_TARGET");
      }
    });
  });

  describe("collectOptionalEvidence（批注 + 已有全文缓存）", function () {
    const cacheText = "  Abstract\nDeep learning has ...\nSection 1 ...";

    function corpus(
      cache: Record<string, string | null>,
      extra: Partial<FakeRuntimeOptions> = {},
    ) {
      const annotations = [
        fakeAnnotation({
          key: "ANNOT001",
          text: "high-light text",
          comment: "my thought",
          pageLabel: "iv",
          sortIndex: "00002|000000|00000",
        }),
        fakeAnnotation({
          key: "ANNOT002",
          comment: "comment only",
          pageLabel: "12",
          sortIndex: "00001|000000|00000",
        }),
        fakeAnnotation({ key: "ANNOT003", text: "   ", pageLabel: "13" }),
        fakeAnnotation({ key: "ANNOT004", text: "deleted", deleted: true }),
      ];
      const attachment = fakeItem({
        id: 11,
        key: "ATTACH01",
        pdf: true,
        parentItemKey: "AAAAAAAA",
        annotations,
        filePath: "/home/user/Zotero/storage/ATTACH01/paper.pdf",
      });
      const parent = fakeItem({
        id: 1,
        key: "AAAAAAAA",
        fields: { title: "带批注的论文" },
        attachments: [11],
      });
      return fakeRuntime({ items: [parent, attachment], cache, ...extra });
    }

    it("读取批注：保留 pageLabel 原字符串，分别记录 attachmentKey 与 annotationKey", async function () {
      const { runtime, calls } = corpus({ ATTACH01: cacheText });
      const result = await collectOptionalEvidence([target("AAAAAAAA")], {
        zotero: runtime,
      });

      const annotations = result.evidence.filter((e) => e.kind === "annotation");
      expect(annotations.map((e) => e.id)).to.deep.equal(["E1", "E2"]);
      expect(annotations[0]).to.include({
        itemKey: "AAAAAAAA",
        attachmentKey: "ATTACH01",
        annotationKey: "ANNOT002",
        pageLabel: "12",
        text: "【批注】comment only",
        extraction: EXTRACTION.annotation,
        truncated: false,
      });
      expect(annotations[1]).to.include({
        annotationKey: "ANNOT001",
        pageLabel: "iv",
        text: "high-light text\n\n【批注】my thought",
      });
      expect(annotations[1].hash).to.equal(hashText(annotations[1].text));
      expect(calls.indexItems).to.equal(0);
      assertNoLocalPaths(result.evidence);
      expect(() => validateEvidenceSet(result.evidence)).to.not.throw();
    });

    it("读取已有全文缓存首段：只给字符范围，不伪造页码", async function () {
      const { runtime, calls } = corpus({ ATTACH01: cacheText });
      const result = await collectOptionalEvidence([target("AAAAAAAA")], {
        zotero: runtime,
      });

      const excerpt = result.evidence.find((e) => e.kind === "pdf_excerpt");
      expect(excerpt).to.not.equal(undefined);
      expect(excerpt).to.include({
        id: "E3",
        attachmentKey: "ATTACH01",
        extraction: EXTRACTION.fulltextCache,
        text: cacheText.trim(),
        start: 2,
        end: 2 + cacheText.trim().length,
        truncated: false,
      });
      expect(excerpt).to.not.have.property("pageLabel");
      expect(excerpt).to.not.have.property("annotationKey");
      expect(calls.getContents).to.have.lengthOf(1);
      expect(calls.indexItems).to.equal(0);
      expect(result.warnings).to.deep.equal([]);
    });

    it("超长批注与缓存均截断并标记 truncated", async function () {
      const longCache = "x".repeat(MAX_FULLTEXT_CHARS + 50);
      const { runtime } = fakeRuntime({
        items: [
          fakeItem({
            id: 1,
            key: "AAAAAAAA",
            fields: { title: "长" },
            attachments: [11],
          }),
          fakeItem({
            id: 11,
            key: "ATTACH01",
            pdf: true,
            parentItemKey: "AAAAAAAA",
            annotations: [
              fakeAnnotation({
                key: "ANNOT001",
                text: "y".repeat(MAX_ANNOTATION_CHARS + 5),
              }),
            ],
          }),
        ],
        cache: { ATTACH01: longCache },
      });
      const result = await collectOptionalEvidence([target("AAAAAAAA")], {
        zotero: runtime,
      });
      const [annotation, excerpt] = result.evidence;
      expect(annotation.text).to.have.lengthOf(MAX_ANNOTATION_CHARS);
      expect(annotation.truncated).to.equal(true);
      expect(excerpt.text).to.have.lengthOf(MAX_FULLTEXT_CHARS);
      expect(excerpt.truncated).to.equal(true);
      expect(excerpt.start).to.equal(0);
      expect(excerpt.end).to.equal(MAX_FULLTEXT_CHARS);
      expect(() => validateEvidenceSet(result.evidence)).to.not.throw();
    });

    it("无缓存时不索引、不下载，只写 warnings", async function () {
      const { runtime, calls } = corpus({});
      const result = await collectOptionalEvidence([target("AAAAAAAA")], {
        zotero: runtime,
      });
      expect(result.evidence.every((e) => e.kind === "annotation")).to.equal(true);
      expect(calls.getContents).to.deep.equal([]);
      expect(calls.indexItems).to.equal(0);
      expect(result.warnings).to.deep.equal([
        "《带批注的论文》的 PDF 尚无 Zotero 全文缓存（未建立索引），已跳过全文片段",
      ]);
    });

    it("没有批注或 PDF 附件时写入明确 warnings", async function () {
      const { runtime } = fakeRuntime({
        items: [fakeItem({ id: 1, key: "AAAAAAAA", fields: { title: "空条目" } })],
      });
      const result = await collectOptionalEvidence([target("AAAAAAAA")], {
        zotero: runtime,
      });
      expect(result.evidence).to.deep.equal([]);
      expect(result.warnings).to.deep.equal([
        "《空条目》没有可用的批注",
        "《空条目》没有 PDF 附件，无法提供全文片段",
      ]);
    });

    it("Fulltext 接口不可用时只提示一次且不抛错", async function () {
      const { runtime } = corpus({}, { withFulltextApi: false });
      const result = await collectOptionalEvidence(
        [target("AAAAAAAA"), target("AAAAAAAA")],
        {
          zotero: runtime,
        },
      );
      expect(
        result.warnings.filter((w) => w.includes("全文缓存接口不可用")),
      ).to.have.lengthOf(1);
    });
  });

  describe("openSource（只读跳转）", function () {
    function corpus() {
      const attachment = fakeItem({
        id: 11,
        key: "ATTACH01",
        pdf: true,
        parentItemKey: "AAAAAAAA",
      });
      const foreign = fakeItem({
        id: 12,
        key: "ATTACH02",
        pdf: true,
        parentItemKey: "ZZZZZZZZ",
      });
      const parent = fakeItem({
        id: 1,
        key: "AAAAAAAA",
        fields: { title: "T" },
        attachments: [11],
      });
      return fakeRuntime({ items: [parent, attachment, foreign] });
    }

    function evidence(overrides: Partial<Evidence>): Evidence {
      return {
        id: "E1",
        libraryID: 1,
        itemKey: "AAAAAAAA",
        kind: "metadata",
        title: "T",
        text: "题名：T",
        hash: hashText("题名：T"),
        extraction: EXTRACTION.metadata,
        truncated: false,
        ...overrides,
      };
    }

    it("题录证据选中条目；批注证据在阅读器中定位批注", async function () {
      const { runtime, calls } = corpus();
      await openSource(evidence({}), { zotero: runtime });
      expect(calls.selectItem).to.deep.equal([1]);
      expect(calls.readerOpen).to.deep.equal([]);

      await openSource(
        evidence({
          kind: "annotation",
          attachmentKey: "ATTACH01",
          annotationKey: "ANNOT001",
        }),
        { zotero: runtime },
      );
      expect(calls.readerOpen).to.deep.equal([
        [11, { annotationKey: "ANNOT001" }, { allowDuplicate: false }],
      ]);

      await openSource(evidence({ kind: "pdf_excerpt", attachmentKey: "ATTACH01" }), {
        zotero: runtime,
      });
      expect(calls.readerOpen[1]).to.deep.equal([
        11,
        undefined,
        { allowDuplicate: false },
      ]);
    });

    it("拒绝不属于该文献的附件、不存在的条目和非法 key（不接受 URL）", async function () {
      const { runtime, calls } = corpus();
      const cases: Array<[Partial<Evidence>, string]> = [
        [{ kind: "pdf_excerpt", attachmentKey: "ATTACH02" }, "SOURCE_MISMATCH"],
        [{ itemKey: "NOPE0000" }, "SOURCE_NOT_FOUND"],
        [{ itemKey: "https://evil.example/paper" as string }, "INVALID_TARGET"],
        [{ kind: "annotation", attachmentKey: "zotero://select/x" }, "INVALID_TARGET"],
      ];
      for (const [overrides, code] of cases) {
        try {
          await openSource(evidence(overrides), { zotero: runtime });
          expect.fail(`应当抛出 ${code}`);
        } catch (error) {
          expect(error).to.be.instanceOf(ExplorerError);
          expect((error as ExplorerError).code).to.equal(code);
        }
      }
      expect(calls.selectItem).to.deep.equal([]);
      expect(calls.readerOpen).to.deep.equal([]);
    });
  });
});
