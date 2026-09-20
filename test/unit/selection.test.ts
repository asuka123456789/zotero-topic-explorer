import { expect } from "chai";
import { collectSelection } from "../../src/zotero/selection.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

describe("collectSelection", function () {
  function createMockItem(opts: {
    key: string;
    libraryID?: number;
    title?: string;
    deleted?: boolean;
    isRegular?: boolean;
    isAttachment?: boolean;
    isAnnotation?: boolean;
    isPDF?: boolean;
    parentItem?: any;
    attachmentContentType?: string;
    attachmentFilename?: string;
  }) {
    return {
      key: opts.key,
      libraryID: opts.libraryID ?? 1,
      deleted: opts.deleted ?? false,
      title: opts.title ?? `Title ${opts.key}`,
      getField: (f: string) =>
        f === "title" ? (opts.title ?? `Title ${opts.key}`) : "",
      getDisplayTitle: () => opts.title ?? `Title ${opts.key}`,
      isRegularItem: () => opts.isRegular ?? (!opts.isAttachment && !opts.isAnnotation),
      isAttachment: () => opts.isAttachment ?? false,
      isAnnotation: () => opts.isAnnotation ?? false,
      isPDFAttachment: () => opts.isPDF ?? false,
      parentItem: opts.parentItem,
      attachmentContentType: opts.attachmentContentType,
      attachmentFilename: opts.attachmentFilename,
    };
  }

  it("should return selection targets for regular items", async function () {
    const item1 = createMockItem({ key: "ITEM1", title: "Paper 1" });
    const item2 = createMockItem({ key: "ITEM2", title: "Paper 2" });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [item1, item2],
      },
    };

    const result = await collectSelection(win);
    expect(result).to.deep.equal([
      { libraryID: 1, itemKey: "ITEM1", title: "Paper 1" },
      { libraryID: 1, itemKey: "ITEM2", title: "Paper 2" },
    ]);
  });

  it("should deduplicate attachments to their parent item", async function () {
    const parent = createMockItem({ key: "PARENT1", title: "Parent Paper" });
    const attach1 = createMockItem({
      key: "ATT1",
      isAttachment: true,
      parentItem: parent,
    });
    const attach2 = createMockItem({
      key: "ATT2",
      isAttachment: true,
      parentItem: parent,
    });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [parent, attach1, attach2],
      },
    };

    const result = await collectSelection(win);
    expect(result).to.have.lengthOf(1);
    expect(result[0]).to.deep.equal({
      libraryID: 1,
      itemKey: "PARENT1",
      title: "Parent Paper",
    });
  });

  it("should allow standalone PDF attachment as target", async function () {
    const standalonePdf = createMockItem({
      key: "PDF1",
      title: "Standalone Document",
      isAttachment: true,
      isPDF: true,
      parentItem: null,
    });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [standalonePdf],
      },
    };

    const result = await collectSelection(win);
    expect(result).to.deep.equal([
      { libraryID: 1, itemKey: "PDF1", title: "Standalone Document" },
    ]);
  });

  it("should reject standalone non-PDF attachment", async function () {
    const standaloneZip = createMockItem({
      key: "ZIP1",
      isAttachment: true,
      isPDF: false,
      parentItem: null,
      attachmentContentType: "application/zip",
      attachmentFilename: "archive.zip",
    });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [standaloneZip],
      },
    };

    try {
      await collectSelection(win);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("INVALID_SELECTION");
    }
  });

  it("should reject items in trash", async function () {
    const trashedItem = createMockItem({
      key: "TRASH1",
      deleted: true,
    });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [trashedItem],
      },
    };

    try {
      await collectSelection(win);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("ITEM_TRASHED");
    }
  });

  it("should reject selection exceeding 20 items without silent truncation", async function () {
    const items: ReturnType<typeof createMockItem>[] = [];
    for (let i = 1; i <= 21; i++) {
      items.push(createMockItem({ key: `KEY_${i}`, title: `Item ${i}` }));
    }
    const win = {
      ZoteroPane: {
        getSelectedItems: () => items,
      },
    };

    try {
      await collectSelection(win);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("SELECTION_LIMIT_EXCEEDED");
    }
  });

  it("should reject cross-library selection", async function () {
    const item1 = createMockItem({ key: "K1", libraryID: 1 });
    const item2 = createMockItem({ key: "K2", libraryID: 2 });
    const win = {
      ZoteroPane: {
        getSelectedItems: () => [item1, item2],
      },
    };

    try {
      await collectSelection(win);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).to.be.instanceOf(ExplorerError);
      expect((err as ExplorerError).code).to.equal("CROSS_LIBRARY_SELECTION");
    }
  });

  it("should collect from current collection default only direct children", async function () {
    const directItem = createMockItem({ key: "DIRECT1", title: "Direct Item" });
    const subItem = createMockItem({ key: "SUB1", title: "Sub Item" });

    const subCol = {
      deleted: false,
      getChildItems: () => [subItem],
      getChildCollections: () => [],
    };
    const mainCol = {
      deleted: false,
      getChildItems: () => [directItem],
      getChildCollections: () => [subCol],
    };

    const win = {
      ZoteroPane: {
        getSelectedCollection: () => mainCol,
      },
    };

    const resultDefault = await collectSelection(win, { collection: true });
    expect(resultDefault).to.have.lengthOf(1);
    expect(resultDefault[0].itemKey).to.equal("DIRECT1");

    const resultRecurse = await collectSelection(win, {
      collection: true,
      includeSubcollections: true,
    });
    expect(resultRecurse).to.have.lengthOf(2);
  });
});
