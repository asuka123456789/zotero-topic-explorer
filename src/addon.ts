import { config } from "../package.json";
import hooks from "./hooks";
import type { ExplorerRuntime } from "./runtime.ts";
import type { RunError } from "./domain/types.ts";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    ztoolkit: ZToolkit;
    runtime: ExplorerRuntime | null;
    runtimeError: RunError | null;
    menuIDs: string[];
  };
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      runtime: null,
      runtimeError: null,
      menuIDs: [],
    };
    this.hooks = hooks;
  }
}

export default Addon;
