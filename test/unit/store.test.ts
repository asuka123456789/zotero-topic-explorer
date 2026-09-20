import { expect } from "chai";
import { SQLiteExplorerStore } from "../../src/storage/sqliteStore.ts";
import { MockSQLiteConnection } from "../fixtures/mockSqlite.ts";
import { MemoryExplorerStore } from "../fixtures/memoryStore.ts";
import { type Project, type Run, type TopicCard } from "../../src/domain/types.ts";
import { ExplorerError } from "../../src/domain/errors.ts";
import { sampleSnapshot, sampleSynthesisOutput } from "../fixtures/sampleData.ts";

describe("SQLiteExplorerStore & MemoryExplorerStore", function () {
  describe("SQLiteExplorerStore", function () {
    let mockConn: MockSQLiteConnection;
    let store: SQLiteExplorerStore;

    beforeEach(async function () {
      mockConn = new MockSQLiteConnection();
      store = new SQLiteExplorerStore(mockConn);
      await store.initialize();
    });

    afterEach(async function () {
      await store.close();
    });

    it("正确初始化并在 PRAGMA 检查通过时设置版本", async function () {
      expect(mockConn.userVersion).to.equal(1);
    });

    it("当数据库版本高于当前插件版本时拒绝降级写入", async function () {
      const conn = new MockSQLiteConnection();
      conn.userVersion = 2; // version > 1
      const badStore = new SQLiteExplorerStore(conn);
      try {
        await badStore.initialize();
        expect.fail("应当抛出版本不支持异常");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("DB_VERSION_UNSUPPORTED");
      }
    });

    it("当 quick_check 损坏时抛出 DB_CORRUPT 并停止", async function () {
      const conn = new MockSQLiteConnection();
      conn.quickCheckResult = "corrupt index at row 42";
      const badStore = new SQLiteExplorerStore(conn);
      try {
        await badStore.initialize();
        expect.fail("应当抛出完整性检查失败");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("DB_CORRUPT");
      }
    });

    it("项目存储：支持创建、读取与乐观锁版本冲突检测", async function () {
      const project: Project = {
        id: "proj-1",
        name: "测试探索课题",
        constraints: sampleSnapshot.constraints,
        evidence: sampleSnapshot.evidence,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const saved = await store.saveProject(project);
      expect(saved.revision).to.equal(1);

      const fetched = await store.getProject("proj-1");
      expect(fetched).to.not.be.null;
      expect(fetched!.name).to.equal("测试探索课题");

      // 正常更新递增 revision
      saved.name = "更新后的课题名称";
      const updated = await store.saveProject(saved, 1);
      expect(updated.revision).to.equal(2);
      expect(updated.name).to.equal("更新后的课题名称");

      // 携带过期的 expectedRevision 抛出版本冲突
      try {
        await store.saveProject(updated, 1);
        expect.fail("应当发生版本冲突");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("REVISION_CONFLICT");
      }
    });

    it("运行记录：创建、查询与原子更新", async function () {
      const run: Run = {
        id: "run-1",
        projectId: "proj-1",
        fingerprint: "fp-12345",
        state: "awaiting_confirmation",
        steps: [],
        requestsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        snapshot: sampleSnapshot,
      };

      await store.createRun(run);

      // 重复创建相同 ID 抛出异常
      try {
        await store.createRun(run);
        expect.fail("重复创建应当失败");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("RUN_ALREADY_EXISTS");
      }

      // 原子更新
      const updated = await store.updateRun("run-1", (r) => {
        r.state = "running";
        r.requestsUsed += 1;
        return r;
      });

      expect(updated.state).to.equal("running");
      expect(updated.requestsUsed).to.equal(1);

      const list = await store.listRuns("proj-1");
      expect(list).to.have.lengthOf(1);
      expect(list[0].id).to.equal("run-1");
    });

    it("卡片存储：支持新建、更新与版本保护", async function () {
      const card: TopicCard = {
        id: "card-1",
        projectId: "proj-1",
        runId: "run-1",
        generated: sampleSynthesisOutput.cards[0],
        status: "exploring",
        notes: "用户初始笔记",
        revision: 1,
        needsReview: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.saveCard(card);

      const list = await store.listCards("proj-1");
      expect(list).to.have.lengthOf(1);
      expect(list[0].generated.candidateId).to.equal("cand-1");

      // 乐观锁冲突
      try {
        await store.saveCard(card, 999);
        expect.fail("应当发生卡片版本冲突");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("REVISION_CONFLICT");
      }
    });

    it("关闭后禁止接受新操作", async function () {
      await store.close();
      try {
        await store.listProjects();
        expect.fail("关闭后操作应抛出 DB_UNAVAILABLE");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("DB_UNAVAILABLE");
      }
    });
  });

  describe("MemoryExplorerStore", function () {
    let memStore: MemoryExplorerStore;

    beforeEach(async function () {
      memStore = new MemoryExplorerStore();
      await memStore.initialize();
    });

    afterEach(async function () {
      await memStore.close();
    });

    it("内存存储符合与 SQLite 一致的乐观锁和深拷贝行为", async function () {
      const project: Project = {
        id: "p-mem-1",
        name: "内存项目",
        constraints: sampleSnapshot.constraints,
        evidence: [],
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await memStore.saveProject(project);
      const fetched = (await memStore.getProject("p-mem-1"))!;
      fetched.name = "直接修改内存引用";

      // 验证深拷贝隔离，修改返回值不影响存储内部数据
      const refetched = (await memStore.getProject("p-mem-1"))!;
      expect(refetched.name).to.equal("内存项目");

      // 乐观锁检查
      try {
        await memStore.saveProject(project, 99);
        expect.fail("应抛出版本冲突");
      } catch (err) {
        expect(err).to.be.instanceOf(ExplorerError);
        expect((err as ExplorerError).code).to.equal("REVISION_CONFLICT");
      }
    });
  });
});
