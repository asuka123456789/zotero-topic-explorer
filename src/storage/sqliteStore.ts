import {
  type ExplorerStore,
  type Project,
  type Run,
  type TopicCard,
} from "../domain/types.ts";
import { ExplorerError } from "../domain/errors.ts";

export interface SQLiteConnection {
  queryAsync(sql: string, params?: unknown[]): Promise<unknown>;
  valueQueryAsync(sql: string, params?: unknown[]): Promise<unknown>;
  executeTransaction<T>(operation: () => Promise<T>): Promise<T>;
  closeDatabase?(): Promise<void>;
}

function getColumnValue<T = unknown>(
  row: unknown,
  colName: string,
  colIndex: number,
): T {
  if (!row || typeof row !== "object") {
    return undefined as unknown as T;
  }
  const r = row as Record<string, unknown>;
  // Zotero.DBConnection 返回的行是 Proxy：按列名取值，访问未知属性会直接抛错，
  // 因此先按列名读取，再回退到原生 mozIStorageRow 接口。
  try {
    const direct = r[colName];
    if (direct !== undefined) {
      return direct as T;
    }
  } catch {
    // 非列名属性在 Zotero 行代理上会抛错，继续尝试其他读取方式
  }
  try {
    if (typeof r.getResultByName === "function") {
      return (r.getResultByName as (name: string) => T)(colName);
    }
    if (typeof r.getResultByIndex === "function") {
      return (r.getResultByIndex as (idx: number) => T)(colIndex);
    }
  } catch {
    // 回退失败时返回 undefined，由调用方按缺失处理
  }
  return undefined as unknown as T;
}

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SQLiteExplorerStore implements ExplorerStore {
  private db: SQLiteConnection;
  private healthy = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(db: SQLiteConnection) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    const rawVersion = await this.db.valueQueryAsync("PRAGMA user_version");
    const version = Number(rawVersion ?? 0);
    if (version > 1) {
      throw new ExplorerError(
        "DB_VERSION_UNSUPPORTED",
        `数据库版本 (${version}) 高于当前插件版本，禁止降级写入`,
      );
    }

    const integrity = await this.db.valueQueryAsync("PRAGMA quick_check");
    if (integrity !== "ok" && integrity !== true) {
      throw new ExplorerError("DB_CORRUPT", "数据库完整性检查失败，已停止写入");
    }

    try {
      await this.db.queryAsync("PRAGMA journal_mode = WAL");
      await this.db.queryAsync("PRAGMA synchronous = FULL");
    } catch {
      // 内存或不支持 WAL 模式时静默降级
    }

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        dataJSON TEXT NOT NULL
      )`);

      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        requestsUsed INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        dataJSON TEXT NOT NULL
      )`);

      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        runId TEXT NOT NULL,
        candidateId TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        dataJSON TEXT NOT NULL
      )`);

      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(projectId)",
      );
      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state)",
      );
      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(projectId)",
      );
      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS idx_cards_candidate ON cards(projectId, candidateId)",
      );

      await this.db.queryAsync("PRAGMA user_version = 1");
    });

    this.healthy = true;
  }

  private assertHealthy(): void {
    if (!this.healthy) {
      throw new ExplorerError("DB_UNAVAILABLE", "数据库不可用或已关闭");
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.assertHealthy();
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ExplorerError)) {
          this.healthy = false;
        }
        throw error;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.tail;
    this.healthy = false;
    if (this.db.closeDatabase) {
      await this.db.closeDatabase();
    }
  }

  async listProjects(): Promise<Project[]> {
    return this.serialize(async () => {
      const rows = (await this.db.queryAsync(
        "SELECT id, revision, createdAt, updatedAt, dataJSON FROM projects ORDER BY updatedAt DESC",
      )) as unknown[];

      if (!Array.isArray(rows)) return [];
      const list: Project[] = [];
      for (const row of rows) {
        const json = getColumnValue<string>(row, "dataJSON", 4);
        if (json) {
          list.push(JSON.parse(json) as Project);
        }
      }
      return list;
    });
  }

  async getProject(id: string): Promise<Project | null> {
    return this.serialize(async () => {
      const rows = (await this.db.queryAsync(
        "SELECT id, revision, createdAt, updatedAt, dataJSON FROM projects WHERE id = ?",
        [id],
      )) as unknown[];

      if (!Array.isArray(rows) || rows.length === 0) return null;
      const json = getColumnValue<string>(rows[0], "dataJSON", 4);
      return json ? (JSON.parse(json) as Project) : null;
    });
  }

  async saveProject(project: Project, expectedRevision?: number): Promise<Project> {
    return this.serialize(async () => {
      return this.db.executeTransaction(async () => {
        const existingRows = (await this.db.queryAsync(
          "SELECT id, revision, createdAt, updatedAt, dataJSON FROM projects WHERE id = ?",
          [project.id],
        )) as unknown[];

        const now = Date.now();
        const clone = deepClone(project);

        if (Array.isArray(existingRows) && existingRows.length > 0) {
          const currentRev = Number(
            getColumnValue<number>(existingRows[0], "revision", 1),
          );
          if (expectedRevision !== undefined && currentRev !== expectedRevision) {
            throw new ExplorerError(
              "REVISION_CONFLICT",
              `项目版本冲突: 期望版本 ${expectedRevision}，当前版本 ${currentRev}`,
            );
          }
          clone.revision = currentRev + 1;
          clone.updatedAt = now;
          await this.db.queryAsync(
            "UPDATE projects SET revision = ?, updatedAt = ?, dataJSON = ? WHERE id = ?",
            [clone.revision, clone.updatedAt, JSON.stringify(clone), clone.id],
          );
        } else {
          clone.revision = clone.revision || 1;
          clone.createdAt = clone.createdAt || now;
          clone.updatedAt = now;
          await this.db.queryAsync(
            "INSERT INTO projects (id, revision, createdAt, updatedAt, dataJSON) VALUES (?, ?, ?, ?, ?)",
            [
              clone.id,
              clone.revision,
              clone.createdAt,
              clone.updatedAt,
              JSON.stringify(clone),
            ],
          );
        }
        return clone;
      });
    });
  }

  async listRuns(projectId: string): Promise<Run[]> {
    return this.serialize(async () => {
      const rows = (await this.db.queryAsync(
        "SELECT id, projectId, fingerprint, state, requestsUsed, createdAt, updatedAt, dataJSON FROM runs WHERE projectId = ? ORDER BY createdAt DESC",
        [projectId],
      )) as unknown[];

      if (!Array.isArray(rows)) return [];
      const list: Run[] = [];
      for (const row of rows) {
        const json = getColumnValue<string>(row, "dataJSON", 7);
        if (json) {
          list.push(JSON.parse(json) as Run);
        }
      }
      return list;
    });
  }

  async getRun(id: string): Promise<Run | null> {
    return this.serialize(async () => {
      const rows = (await this.db.queryAsync(
        "SELECT id, projectId, fingerprint, state, requestsUsed, createdAt, updatedAt, dataJSON FROM runs WHERE id = ?",
        [id],
      )) as unknown[];

      if (!Array.isArray(rows) || rows.length === 0) return null;
      const json = getColumnValue<string>(rows[0], "dataJSON", 7);
      return json ? (JSON.parse(json) as Run) : null;
    });
  }

  async createRun(run: Run): Promise<void> {
    return this.serialize(async () => {
      return this.db.executeTransaction(async () => {
        const existing = (await this.db.queryAsync("SELECT id FROM runs WHERE id = ?", [
          run.id,
        ])) as unknown[];

        if (Array.isArray(existing) && existing.length > 0) {
          throw new ExplorerError("RUN_ALREADY_EXISTS", `运行记录 ${run.id} 已存在`);
        }

        const clone = deepClone(run);
        await this.db.queryAsync(
          "INSERT INTO runs (id, projectId, fingerprint, state, requestsUsed, createdAt, updatedAt, dataJSON) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            clone.id,
            clone.projectId,
            clone.fingerprint,
            clone.state,
            clone.requestsUsed,
            clone.createdAt,
            clone.updatedAt,
            JSON.stringify(clone),
          ],
        );
      });
    });
  }

  async updateRun(id: string, change: (run: Run) => Run): Promise<Run> {
    return this.serialize(async () => {
      return this.db.executeTransaction(async () => {
        const rows = (await this.db.queryAsync(
          "SELECT id, projectId, fingerprint, state, requestsUsed, createdAt, updatedAt, dataJSON FROM runs WHERE id = ?",
          [id],
        )) as unknown[];

        if (!Array.isArray(rows) || rows.length === 0) {
          throw new ExplorerError("RUN_NOT_FOUND", `运行记录 ${id} 不存在`);
        }

        const json = getColumnValue<string>(rows[0], "dataJSON", 7);
        const current = JSON.parse(json) as Run;
        const updated = change(deepClone(current));
        if (updated.id !== id) {
          throw new ExplorerError("INVALID_RUN_UPDATE", "禁止修改运行记录的主键 ID");
        }

        updated.updatedAt = Date.now();
        await this.db.queryAsync(
          "UPDATE runs SET fingerprint = ?, state = ?, requestsUsed = ?, updatedAt = ?, dataJSON = ? WHERE id = ?",
          [
            updated.fingerprint,
            updated.state,
            updated.requestsUsed,
            updated.updatedAt,
            JSON.stringify(updated),
            id,
          ],
        );

        return updated;
      });
    });
  }

  async listCards(projectId: string): Promise<TopicCard[]> {
    return this.serialize(async () => {
      const rows = (await this.db.queryAsync(
        "SELECT id, projectId, runId, candidateId, status, revision, createdAt, updatedAt, dataJSON FROM cards WHERE projectId = ? ORDER BY updatedAt DESC",
        [projectId],
      )) as unknown[];

      if (!Array.isArray(rows)) return [];
      const list: TopicCard[] = [];
      for (const row of rows) {
        const json = getColumnValue<string>(row, "dataJSON", 8);
        if (json) {
          list.push(JSON.parse(json) as TopicCard);
        }
      }
      return list;
    });
  }

  async saveCard(card: TopicCard, expectedRevision?: number): Promise<TopicCard> {
    return this.serialize(async () => {
      return this.db.executeTransaction(async () => {
        const existingRows = (await this.db.queryAsync(
          "SELECT id, revision, createdAt, updatedAt, dataJSON FROM cards WHERE id = ?",
          [card.id],
        )) as unknown[];

        const now = Date.now();
        const clone = deepClone(card);
        const candidateId = clone.generated?.candidateId || "";

        if (Array.isArray(existingRows) && existingRows.length > 0) {
          const currentRev = Number(
            getColumnValue<number>(existingRows[0], "revision", 1),
          );
          if (expectedRevision !== undefined && currentRev !== expectedRevision) {
            throw new ExplorerError(
              "REVISION_CONFLICT",
              `卡片版本冲突: 期望版本 ${expectedRevision}，当前版本 ${currentRev}`,
            );
          }
          clone.revision = currentRev + 1;
          clone.updatedAt = now;
          await this.db.queryAsync(
            "UPDATE cards SET status = ?, revision = ?, updatedAt = ?, dataJSON = ? WHERE id = ?",
            [
              clone.status,
              clone.revision,
              clone.updatedAt,
              JSON.stringify(clone),
              clone.id,
            ],
          );
        } else {
          clone.revision = clone.revision || 1;
          clone.createdAt = clone.createdAt || now;
          clone.updatedAt = now;
          await this.db.queryAsync(
            "INSERT INTO cards (id, projectId, runId, candidateId, status, revision, createdAt, updatedAt, dataJSON) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              clone.id,
              clone.projectId,
              clone.runId,
              candidateId,
              clone.status,
              clone.revision,
              clone.createdAt,
              clone.updatedAt,
              JSON.stringify(clone),
            ],
          );
        }
        return clone;
      });
    });
  }
}
