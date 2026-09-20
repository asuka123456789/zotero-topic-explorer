import {
  type ExplorerStore,
  type Project,
  type Run,
  type TopicCard,
} from "../../src/domain/types.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

function deepClone<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val)) as T;
}

export class MemoryExplorerStore implements ExplorerStore {
  private projects = new Map<string, Project>();
  private runs = new Map<string, Run>();
  private cards = new Map<string, TopicCard>();
  private closed = false;
  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
    this.closed = false;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private checkState(): void {
    if (this.closed) {
      throw new ExplorerError("STORE_CLOSED", "存储已关闭");
    }
    if (!this.initialized) {
      throw new ExplorerError("STORE_NOT_INITIALIZED", "存储尚未初始化");
    }
  }

  async listProjects(): Promise<Project[]> {
    this.checkState();
    return Array.from(this.projects.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => deepClone(p));
  }

  async getProject(id: string): Promise<Project | null> {
    this.checkState();
    const p = this.projects.get(id);
    return p ? deepClone(p) : null;
  }

  async saveProject(project: Project, expectedRevision?: number): Promise<Project> {
    this.checkState();
    const existing = this.projects.get(project.id);
    const now = Date.now();
    const copy = deepClone(project);

    if (existing) {
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new ExplorerError(
          "REVISION_CONFLICT",
          `项目版本冲突: 期望 ${expectedRevision}, 实际 ${existing.revision}`,
        );
      }
      copy.revision = existing.revision + 1;
      copy.updatedAt = now;
    } else {
      copy.revision = copy.revision || 1;
      copy.createdAt = copy.createdAt || now;
      copy.updatedAt = now;
    }

    this.projects.set(copy.id, deepClone(copy));
    return copy;
  }

  async listRuns(projectId: string): Promise<Run[]> {
    this.checkState();
    return Array.from(this.runs.values())
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => deepClone(r));
  }

  async getRun(id: string): Promise<Run | null> {
    this.checkState();
    const r = this.runs.get(id);
    return r ? deepClone(r) : null;
  }

  async createRun(run: Run): Promise<void> {
    this.checkState();
    if (this.runs.has(run.id)) {
      throw new ExplorerError("RUN_ALREADY_EXISTS", `运行 ${run.id} 已存在`);
    }
    this.runs.set(run.id, deepClone(run));
  }

  async updateRun(id: string, change: (run: Run) => Run): Promise<Run> {
    this.checkState();
    const current = this.runs.get(id);
    if (!current) {
      throw new ExplorerError("RUN_NOT_FOUND", `运行 ${id} 未找到`);
    }

    const updated = change(deepClone(current));
    if (updated.id !== id) {
      throw new ExplorerError("INVALID_RUN_UPDATE", "禁止修改运行 ID");
    }

    updated.updatedAt = Date.now();
    this.runs.set(id, deepClone(updated));
    return deepClone(updated);
  }

  async listCards(projectId: string): Promise<TopicCard[]> {
    this.checkState();
    return Array.from(this.cards.values())
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => deepClone(c));
  }

  async saveCard(card: TopicCard, expectedRevision?: number): Promise<TopicCard> {
    this.checkState();
    const existing = this.cards.get(card.id);
    const now = Date.now();
    const copy = deepClone(card);

    if (existing) {
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new ExplorerError(
          "REVISION_CONFLICT",
          `卡片版本冲突: 期望 ${expectedRevision}, 实际 ${existing.revision}`,
        );
      }
      copy.revision = existing.revision + 1;
      copy.updatedAt = now;
    } else {
      copy.revision = copy.revision || 1;
      copy.createdAt = copy.createdAt || now;
      copy.updatedAt = now;
    }

    this.cards.set(copy.id, deepClone(copy));
    return copy;
  }
}
