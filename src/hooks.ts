import { config } from "../package.json";
import { safeError } from "./domain/errors.ts";
import { ExplorerRuntime } from "./runtime.ts";
import { closeWorkbench, openWorkbench } from "./ui/workbench.ts";
import { getLocaleID, logInternalError } from "./utils/common.ts";

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  try {
    addon.data.runtime = await ExplorerRuntime.create();
  } catch (error) {
    // 数据库损坏或版本超前时保留现场，工作台只显示错误，不删除重建。
    addon.data.runtimeError = safeError(error);
    logInternalError("startup", error);
  }

  registerMenus();
  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));
  addon.data.initialized = true;
}

function registerMenus(): void {
  const manager = Zotero.MenuManager;
  const register = (options: Parameters<typeof manager.registerMenu>[0]) => {
    const id = manager.registerMenu(options);
    if (id) {
      addon.data.menuIDs.push(id);
    }
  };
  register({
    menuID: `${config.addonRef}-item-menu`,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-explore-items"),
        onCommand: () => launch("items"),
      },
    ],
  });
  register({
    menuID: `${config.addonRef}-collection-menu`,
    pluginID: config.addonID,
    target: "main/library/collection",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-explore-collection"),
        onCommand: () => launch("collection"),
      },
    ],
  });
  register({
    menuID: `${config.addonRef}-tools-menu`,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-open-workbench"),
        onCommand: () => launch(null),
      },
    ],
  });
}

function unregisterMenus(): void {
  for (const id of addon.data.menuIDs) {
    try {
      Zotero.MenuManager.unregisterMenu(id);
    } catch (error) {
      logInternalError("menu", error);
    }
  }
  addon.data.menuIDs = [];
}

function launch(mode: "items" | "collection" | null): void {
  void (async () => {
    try {
      const runtime = addon.data.runtime;
      if (!runtime) {
        const message = addon.data.runtimeError?.message ?? "插件尚未完成初始化";
        Zotero.getMainWindow().alert(`选题探索不可用：${message}`);
        return;
      }
      let payload = undefined;
      if (mode) {
        payload = await runtime.collectFromMainWindow(mode, false);
      }
      await openWorkbench(runtime, payload);
    } catch (error) {
      const safe = safeError(error);
      Zotero.getMainWindow().alert(`选题探索：${safe.message}`);
      logInternalError("launch", error);
    }
  })();
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
}

async function onMainWindowUnload(_win: Window): Promise<void> {}

async function onShutdown(): Promise<void> {
  closeWorkbench();
  unregisterMenus();
  try {
    await addon.data.runtime?.shutdown();
  } catch (error) {
    logInternalError("shutdown", error);
  }
  addon.data.runtime = null;
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
