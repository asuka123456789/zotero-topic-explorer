import { type SQLiteConnection } from "../../src/storage/sqliteStore.ts";

export interface MockRow {
  getResultByName(name: string): unknown;
  getResultByIndex(index: number): unknown;
  [key: string]: unknown;
}

export function createMockRow(
  data: Record<string, unknown>,
  colOrder: string[],
): MockRow {
  return {
    ...data,
    getResultByName(name: string) {
      return data[name];
    },
    getResultByIndex(index: number) {
      const key = colOrder[index];
      return data[key];
    },
  };
}

export class MockSQLiteConnection implements SQLiteConnection {
  public userVersion = 0;
  public quickCheckResult: string = "ok";
  public closed = false;

  public projectsTable = new Map<
    string,
    {
      id: string;
      revision: number;
      createdAt: number;
      updatedAt: number;
      dataJSON: string;
    }
  >();
  public runsTable = new Map<
    string,
    {
      id: string;
      projectId: string;
      fingerprint: string;
      state: string;
      requestsUsed: number;
      createdAt: number;
      updatedAt: number;
      dataJSON: string;
    }
  >();
  public cardsTable = new Map<
    string,
    {
      id: string;
      projectId: string;
      runId: string;
      candidateId: string;
      status: string;
      revision: number;
      createdAt: number;
      updatedAt: number;
      dataJSON: string;
    }
  >();

  async valueQueryAsync(sql: string): Promise<unknown> {
    if (sql.includes("PRAGMA user_version")) {
      return this.userVersion;
    }
    if (sql.includes("PRAGMA quick_check")) {
      return this.quickCheckResult;
    }
    return null;
  }

  async queryAsync(sql: string, params: unknown[] = []): Promise<unknown> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("PRAGMA user_version =")) {
      const match = /PRAGMA user_version = (\d+)/.exec(trimmed);
      if (match) this.userVersion = parseInt(match[1], 10);
      return [];
    }
    if (trimmed.startsWith("PRAGMA")) {
      return [];
    }
    if (trimmed.startsWith("CREATE TABLE") || trimmed.startsWith("CREATE INDEX")) {
      return [];
    }

    // Projects queries
    if (trimmed.includes("FROM projects WHERE id = ?")) {
      const id = params[0] as string;
      const row = this.projectsTable.get(id);
      if (!row) return [];
      return [
        createMockRow(row, ["id", "revision", "createdAt", "updatedAt", "dataJSON"]),
      ];
    }
    if (trimmed.includes("FROM projects ORDER BY updatedAt DESC")) {
      return Array.from(this.projectsTable.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((r) =>
          createMockRow(r, ["id", "revision", "createdAt", "updatedAt", "dataJSON"]),
        );
    }
    if (trimmed.startsWith("INSERT INTO projects")) {
      const [id, revision, createdAt, updatedAt, dataJSON] = params as [
        string,
        number,
        number,
        number,
        string,
      ];
      this.projectsTable.set(id, { id, revision, createdAt, updatedAt, dataJSON });
      return [];
    }
    if (trimmed.startsWith("UPDATE projects SET")) {
      const [revision, updatedAt, dataJSON, id] = params as [
        number,
        number,
        string,
        string,
      ];
      this.projectsTable.set(id, {
        id,
        revision,
        updatedAt,
        createdAt: this.projectsTable.get(id)?.createdAt ?? updatedAt,
        dataJSON,
      });
      return [];
    }

    // Runs queries
    if (trimmed.includes("FROM runs WHERE id = ?")) {
      const id = params[0] as string;
      const row = this.runsTable.get(id);
      if (!row) return [];
      return [
        createMockRow(row, [
          "id",
          "projectId",
          "fingerprint",
          "state",
          "requestsUsed",
          "createdAt",
          "updatedAt",
          "dataJSON",
        ]),
      ];
    }
    if (trimmed.includes("FROM runs WHERE projectId = ?")) {
      const projectId = params[0] as string;
      return Array.from(this.runsTable.values())
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) =>
          createMockRow(r, [
            "id",
            "projectId",
            "fingerprint",
            "state",
            "requestsUsed",
            "createdAt",
            "updatedAt",
            "dataJSON",
          ]),
        );
    }
    if (trimmed.startsWith("INSERT INTO runs")) {
      const [
        id,
        projectId,
        fingerprint,
        state,
        requestsUsed,
        createdAt,
        updatedAt,
        dataJSON,
      ] = params as [string, string, string, string, number, number, number, string];
      this.runsTable.set(id, {
        id,
        projectId,
        fingerprint,
        state,
        requestsUsed,
        createdAt,
        updatedAt,
        dataJSON,
      });
      return [];
    }
    if (trimmed.startsWith("UPDATE runs SET")) {
      const [fingerprint, state, requestsUsed, updatedAt, dataJSON, id] = params as [
        string,
        string,
        number,
        number,
        string,
        string,
      ];
      const prev = this.runsTable.get(id);
      if (prev) {
        this.runsTable.set(id, {
          ...prev,
          fingerprint,
          state,
          requestsUsed,
          updatedAt,
          dataJSON,
        });
      }
      return [];
    }

    // Cards queries
    if (trimmed.includes("FROM cards WHERE id = ?")) {
      const id = params[0] as string;
      const row = this.cardsTable.get(id);
      if (!row) return [];
      return [
        createMockRow(row, [
          "id",
          "projectId",
          "runId",
          "candidateId",
          "status",
          "revision",
          "createdAt",
          "updatedAt",
          "dataJSON",
        ]),
      ];
    }
    if (trimmed.includes("FROM cards WHERE projectId = ?")) {
      const projectId = params[0] as string;
      return Array.from(this.cardsTable.values())
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) =>
          createMockRow(c, [
            "id",
            "projectId",
            "runId",
            "candidateId",
            "status",
            "revision",
            "createdAt",
            "updatedAt",
            "dataJSON",
          ]),
        );
    }
    if (trimmed.startsWith("INSERT INTO cards")) {
      const [
        id,
        projectId,
        runId,
        candidateId,
        status,
        revision,
        createdAt,
        updatedAt,
        dataJSON,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        string,
      ];
      this.cardsTable.set(id, {
        id,
        projectId,
        runId,
        candidateId,
        status,
        revision,
        createdAt,
        updatedAt,
        dataJSON,
      });
      return [];
    }
    if (trimmed.startsWith("UPDATE cards SET")) {
      const [status, revision, updatedAt, dataJSON, id] = params as [
        string,
        number,
        number,
        string,
        string,
      ];
      const prev = this.cardsTable.get(id);
      if (prev) {
        this.cardsTable.set(id, { ...prev, status, revision, updatedAt, dataJSON });
      }
      return [];
    }

    return [];
  }

  async executeTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return await operation();
  }

  async closeDatabase(): Promise<void> {
    this.closed = true;
  }
}
