import { defineConfig } from "zotero-plugin-scaffold";
import { readFile } from "node:fs/promises";
import pkg from "./package.json" with { type: "json" };

// Zotero 9 要求非空 HTTPS update_url；保留 .invalid 占位，本插件不提供在线更新。
const DISABLED_UPDATE_URL =
  "https://example.invalid/zotero-topic-explorer/updates.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,

  build: {
    // manifest 由本项目维护，避免脚手架按仓库信息注入更新地址。
    makeManifest: { enable: false },
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      disabledUpdateURL: DISABLED_UPDATE_URL,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV ?? "production"}"`,
        },
        bundle: true,
        target: "firefox128",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    startArgs: ["-no-remote"],
    devtools: false,
  },

  test: {
    entries: ["test/integration"],
    watch: false,
    // scaffold 在 Windows 上没有无头模式；运行前须另行协调是否允许显示 Zotero 窗口。
    headless: false,
    mocha: { timeout: 60000 },
    prefs: {
      [`${pkg.config.prefsPrefix}.test.isolated`]: true,
      "extensions.zotero.sync.autoSync": false,
      "extensions.update.enabled": false,
    },
    waitForPlugin: `() => !!Zotero.${pkg.config.addonInstance}?.data.initialized`,
  },

  hooks: {
    "build:makeManifest": async (ctx) => {
      const manifest = JSON.parse(
        await readFile(`${ctx.dist}/addon/manifest.json`, "utf8"),
      );
      const application = manifest.applications?.zotero;
      if (
        application?.id !== pkg.config.addonID ||
        manifest.version !== pkg.version ||
        application.update_url !== DISABLED_UPDATE_URL
      ) {
        throw new Error("manifest 身份、版本或禁用自动更新约束未满足");
      }
    },
  },
});
