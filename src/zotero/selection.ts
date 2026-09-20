import type { SelectionTarget } from "../domain/types.ts";
import { ExplorerError } from "../domain/errors.ts";

export interface CollectSelectionOptions {
  collection?: boolean;
  includeSubcollections?: boolean;
}

export async function collectSelection(
  win: any,
  options?: CollectSelectionOptions,
): Promise<SelectionTarget[]> {
  const pane =
    win?.ZoteroPane ??
    win?.Zotero?.getActiveZoteroPane?.() ??
    (typeof (globalThis as any).Zotero !== "undefined"
      ? (globalThis as any).Zotero.getActiveZoteroPane?.()
      : undefined);

  if (!pane) {
    throw new ExplorerError("NO_ACTIVE_PANE", "No active Zotero pane found");
  }

  let rawItems: any[];

  if (options?.collection) {
    const collection = pane.getSelectedCollection
      ? pane.getSelectedCollection()
      : undefined;

    if (!collection) {
      throw new ExplorerError(
        "NO_COLLECTION_SELECTED",
        "No collection is currently selected in active pane",
      );
    }

    if (collection.deleted || collection.inTrash) {
      throw new ExplorerError("ITEM_TRASHED", "Selected collection is in trash");
    }

    const collected: any[] = [];
    const traverse = (col: any, includeSubs: boolean) => {
      const childItems = col.getChildItems ? col.getChildItems(false, false) : [];
      collected.push(...childItems);
      if (includeSubs && col.getChildCollections) {
        const subCols = col.getChildCollections(false, false);
        for (const sub of subCols) {
          traverse(sub, includeSubs);
        }
      }
    };

    traverse(collection, options.includeSubcollections ?? false);
    rawItems = collected;
  } else {
    rawItems = pane.getSelectedItems ? pane.getSelectedItems() : [];
    if (!rawItems || rawItems.length === 0) {
      return [];
    }
  }

  const targetsMap = new Map<string, SelectionTarget>();

  for (const item of rawItems) {
    if (!item) continue;

    const isDeleted =
      item.deleted === true ||
      (typeof item.isDeleted === "function" && item.isDeleted()) ||
      item.inTrash === true;

    if (isDeleted) {
      throw new ExplorerError(
        "ITEM_TRASHED",
        `Item ${item.key ?? item.id ?? ""} is in trash`,
      );
    }

    const isAttachment =
      typeof item.isAttachment === "function" ? item.isAttachment() : false;
    const isAnnotation =
      typeof item.isAnnotation === "function" ? item.isAnnotation() : false;
    const isRegular =
      typeof item.isRegularItem === "function"
        ? item.isRegularItem()
        : !isAttachment && !isAnnotation && !(item.isNote && item.isNote());

    if (isRegular) {
      const title =
        (typeof item.getField === "function" ? item.getField("title") : "") ||
        (typeof item.getDisplayTitle === "function" ? item.getDisplayTitle() : "") ||
        item.title ||
        "Untitled";

      const target: SelectionTarget = {
        libraryID: item.libraryID,
        itemKey: item.key,
        title: title || "Untitled",
      };
      targetsMap.set(`${item.libraryID}:${item.key}`, target);
      continue;
    }

    if (isAttachment) {
      let parent = item.parentItem;
      if (!parent && item.parentItemID != null && item.parentItemID !== false) {
        const zItems =
          pane.Zotero?.Items ?? win?.Zotero?.Items ?? (globalThis as any).Zotero?.Items;
        parent = zItems?.get?.(item.parentItemID);
      }

      if (parent) {
        const parentDeleted =
          parent.deleted === true ||
          (typeof parent.isDeleted === "function" && parent.isDeleted()) ||
          parent.inTrash === true;

        if (parentDeleted) {
          throw new ExplorerError(
            "ITEM_TRASHED",
            `Parent item of attachment ${item.key ?? ""} is in trash`,
          );
        }

        const title =
          (typeof parent.getField === "function" ? parent.getField("title") : "") ||
          (typeof parent.getDisplayTitle === "function"
            ? parent.getDisplayTitle()
            : "") ||
          parent.title ||
          "Untitled";

        const target: SelectionTarget = {
          libraryID: parent.libraryID,
          itemKey: parent.key,
          title: title || "Untitled",
        };
        targetsMap.set(`${parent.libraryID}:${parent.key}`, target);
      } else {
        const isPDF =
          (typeof item.isPDFAttachment === "function" && item.isPDFAttachment()) ||
          item.attachmentContentType === "application/pdf" ||
          item.contentType === "application/pdf" ||
          (typeof item.attachmentFilename === "string" &&
            item.attachmentFilename.toLowerCase().endsWith(".pdf"));

        if (isPDF) {
          const title =
            (typeof item.getField === "function" ? item.getField("title") : "") ||
            (typeof item.getDisplayTitle === "function"
              ? item.getDisplayTitle()
              : "") ||
            item.attachmentFilename ||
            "Untitled PDF";

          const target: SelectionTarget = {
            libraryID: item.libraryID,
            itemKey: item.key,
            title: title || "Untitled PDF",
          };
          targetsMap.set(`${item.libraryID}:${item.key}`, target);
        } else {
          throw new ExplorerError(
            "INVALID_SELECTION",
            `Standalone attachment ${item.key ?? ""} is not a PDF`,
          );
        }
      }
      continue;
    }

    if (isAnnotation) {
      let parent = item.parentItem;
      if (
        parent &&
        typeof parent.isAttachment === "function" &&
        parent.isAttachment()
      ) {
        if (parent.parentItem) {
          parent = parent.parentItem;
        } else if (parent.parentItemID != null && parent.parentItemID !== false) {
          const zItems =
            pane.Zotero?.Items ??
            win?.Zotero?.Items ??
            (globalThis as any).Zotero?.Items;
          parent = zItems?.get?.(parent.parentItemID) ?? parent;
        }
      }

      if (parent) {
        const parentDeleted =
          parent.deleted === true ||
          (typeof parent.isDeleted === "function" && parent.isDeleted()) ||
          parent.inTrash === true;

        if (parentDeleted) {
          throw new ExplorerError(
            "ITEM_TRASHED",
            `Parent of annotation ${item.key ?? ""} is in trash`,
          );
        }

        const title =
          (typeof parent.getField === "function" ? parent.getField("title") : "") ||
          (typeof parent.getDisplayTitle === "function"
            ? parent.getDisplayTitle()
            : "") ||
          parent.title ||
          "Untitled";

        const target: SelectionTarget = {
          libraryID: parent.libraryID,
          itemKey: parent.key,
          title: title || "Untitled",
        };
        targetsMap.set(`${parent.libraryID}:${parent.key}`, target);
      } else {
        throw new ExplorerError(
          "INVALID_SELECTION",
          `Annotation ${item.key ?? ""} has no resolvable parent item`,
        );
      }
      continue;
    }

    if (item.parentItem) {
      const parent = item.parentItem;
      const title =
        (typeof parent.getField === "function" ? parent.getField("title") : "") ||
        (typeof parent.getDisplayTitle === "function"
          ? parent.getDisplayTitle()
          : "") ||
        parent.title ||
        "Untitled";

      const target: SelectionTarget = {
        libraryID: parent.libraryID,
        itemKey: parent.key,
        title: title || "Untitled",
      };
      targetsMap.set(`${parent.libraryID}:${parent.key}`, target);
      continue;
    }

    throw new ExplorerError(
      "INVALID_SELECTION",
      `Selected item ${item.key ?? item.id ?? ""} is not a valid literature item or standalone PDF`,
    );
  }

  const targets = Array.from(targetsMap.values());

  if (targets.length > 0) {
    const firstLib = targets[0].libraryID;
    for (const t of targets) {
      if (t.libraryID !== firstLib) {
        throw new ExplorerError(
          "CROSS_LIBRARY_SELECTION",
          `Selection spans multiple libraries (${firstLib} and ${t.libraryID})`,
        );
      }
    }
  }

  if (targets.length > 20) {
    throw new ExplorerError(
      "SELECTION_LIMIT_EXCEEDED",
      `Selected ${targets.length} items exceeds the maximum allowed limit of 20 items. Cannot truncate silently.`,
    );
  }

  return targets;
}
