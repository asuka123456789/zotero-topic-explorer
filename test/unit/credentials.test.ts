import { expect } from "chai";
import {
  CREDENTIAL_ORIGIN,
  CredentialStore,
  credentialRealm,
  type LoginInfoLike,
  type LoginManagerLike,
} from "../../src/zotero/credentials.ts";
import { ExplorerError } from "../../src/domain/errors.ts";

class FakeLoginInfo implements LoginInfoLike {
  origin = "";
  formActionOrigin: string | null = null;
  httpRealm: string | null = null;
  username = "";
  password = "";

  init(
    origin: string,
    formActionOrigin: string | null,
    httpRealm: string | null,
    username: string,
    password: string,
  ): void {
    this.origin = origin;
    this.formActionOrigin = formActionOrigin;
    this.httpRealm = httpRealm;
    this.username = username;
    this.password = password;
  }
}

class FakeLoginManager implements LoginManagerLike {
  initializationPromise?: Promise<unknown>;
  logins: FakeLoginInfo[] = [];
  calls: string[] = [];
  failAdd = false;
  /** 模拟不按 realm 过滤的实现，用于检验存储层自身的二次过滤。 */
  ignoreRealm = false;

  findLogins(
    origin: string,
    _action: string | null,
    realm: string | null,
  ): LoginInfoLike[] {
    this.calls.push(`find:${origin}|${realm}`);
    return this.logins.filter(
      (login) =>
        login.origin === origin && (this.ignoreRealm || login.httpRealm === realm),
    );
  }

  async addLoginAsync(login: LoginInfoLike): Promise<void> {
    this.calls.push("add");
    if (this.failAdd) {
      throw new Error("NS_ERROR_FAILURE: master password locked");
    }
    this.logins.push(login as FakeLoginInfo);
  }

  removeLogin(login: LoginInfoLike): void {
    this.calls.push("remove");
    this.logins = this.logins.filter((entry) => entry !== login);
  }
}

function makeStore(manager: LoginManagerLike | null) {
  return new CredentialStore({
    loginManager: manager,
    createLoginInfo: () => new FakeLoginInfo(),
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<ExplorerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(ExplorerError);
    expect((error as ExplorerError).code).to.equal(code);
    return error as ExplorerError;
  }
  return expect.fail(`应当抛出 ${code}`);
}

describe("CredentialStore", function () {
  it("persist=true 时写入 Login Manager，origin/realm 使用插件专属值", async function () {
    const manager = new FakeLoginManager();
    const store = makeStore(manager);

    await store.set("gpt-main", "sk-live-1234", true);

    expect(manager.logins).to.have.lengthOf(1);
    expect(manager.logins[0]).to.include({
      origin: CREDENTIAL_ORIGIN,
      formActionOrigin: null,
      httpRealm: "zotero-topic-explorer:gpt-main",
      username: "gpt-main",
      password: "sk-live-1234",
    });
    expect(credentialRealm("gpt-main")).to.equal("zotero-topic-explorer:gpt-main");
    expect(await store.get("gpt-main")).to.equal("sk-live-1234");
    expect(await store.has("gpt-main")).to.equal(true);
  });

  it("重复保存会先删除旧条目，只保留最新密钥", async function () {
    const manager = new FakeLoginManager();
    const store = makeStore(manager);
    await store.set("m1", "old-key");
    await store.set("m1", "new-key");
    expect(manager.logins.map((login) => login.password)).to.deep.equal(["new-key"]);
    expect(manager.calls).to.deep.equal([
      `find:${CREDENTIAL_ORIGIN}|zotero-topic-explorer:m1`,
      "add",
      `find:${CREDENTIAL_ORIGIN}|zotero-topic-explorer:m1`,
      "remove",
      "add",
    ]);
    expect(await store.get("m1")).to.equal("new-key");
  });

  it("remove 删除 Login Manager 条目与会话内存，之后 get 报 CREDENTIAL_MISSING", async function () {
    const manager = new FakeLoginManager();
    const store = makeStore(manager);
    await store.set("m1", "key-a");
    await store.set("m2", "key-b", false);
    await store.remove("m1");
    await store.remove("m2");
    expect(manager.logins).to.deep.equal([]);
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");
    await expectCode(store.get("m2"), "CREDENTIAL_MISSING");
    expect(await store.has("m1")).to.equal(false);
  });

  it("persist=false 只保存在会话内存，不触碰 Login Manager", async function () {
    const manager = new FakeLoginManager();
    const store = makeStore(manager);
    await store.set("local", "sk-session", false);
    expect(manager.calls).to.deep.equal([]);
    expect(manager.logins).to.deep.equal([]);
    expect(await store.get("local")).to.equal("sk-session");
    expect(manager.calls).to.deep.equal([]);
    store.clearSession();
    await expectCode(store.get("local"), "CREDENTIAL_MISSING");
  });

  it("Login Manager 不可用时退回会话内存，且不写任何持久化位置", async function () {
    const store = makeStore(null);
    expect(store.persistenceAvailable).to.equal(false);
    await store.set("m1", "sk-mem", true);
    expect(await store.get("m1")).to.equal("sk-mem");
    await store.remove("m1");
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");
  });

  it("不能读取其他 realm 或其他 origin 的登录条目", async function () {
    const manager = new FakeLoginManager();
    const otherRealm = new FakeLoginInfo();
    otherRealm.init(
      CREDENTIAL_ORIGIN,
      null,
      "zotero-topic-explorer:other",
      "other",
      "sk-other",
    );
    const otherOrigin = new FakeLoginInfo();
    otherOrigin.init(
      "https://api.example.com",
      null,
      "zotero-topic-explorer:m1",
      "m1",
      "sk-web",
    );
    manager.logins.push(otherRealm, otherOrigin);

    const store = makeStore(manager);
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");

    manager.ignoreRealm = true;
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");
    await store.remove("m1");
    expect(manager.logins).to.have.lengthOf(2);
  });

  it("持久化失败时抛错、不降级为明文，且会话内不残留密钥", async function () {
    const manager = new FakeLoginManager();
    manager.failAdd = true;
    const store = makeStore(manager);
    const error = await expectCode(
      store.set("m1", "sk-secret"),
      "CREDENTIAL_PERSIST_FAILED",
    );
    expect(error.message).to.not.include("sk-secret");
    expect(error.message).to.not.include("NS_ERROR");
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");
    expect(manager.logins).to.deep.equal([]);
  });

  it("无法创建 nsILoginInfo 时抛 CREDENTIAL_STORE_UNAVAILABLE，不落入内存", async function () {
    const manager = new FakeLoginManager();
    const store = new CredentialStore({ loginManager: manager });
    await expectCode(store.set("m1", "sk-x"), "CREDENTIAL_STORE_UNAVAILABLE");
    await expectCode(store.get("m1"), "CREDENTIAL_MISSING");
  });

  it("等待 initializationPromise；初始化失败报 CREDENTIAL_STORE_UNAVAILABLE", async function () {
    const manager = new FakeLoginManager();
    manager.initializationPromise = Promise.reject(new Error("locked"));
    manager.initializationPromise.catch(() => undefined);
    const store = makeStore(manager);
    await expectCode(store.get("m1"), "CREDENTIAL_STORE_UNAVAILABLE");
  });

  it("拒绝非法配置 ID 与空密钥", async function () {
    const store = makeStore(new FakeLoginManager());
    await expectCode(store.set("bad id", "sk"), "INVALID_ARGUMENT");
    await expectCode(store.set("../x", "sk"), "INVALID_ARGUMENT");
    await expectCode(store.set("m1", "   "), "INVALID_ARGUMENT");
    await expectCode(store.set("m1", "sk\nx"), "INVALID_ARGUMENT");
    await expectCode(store.get(""), "INVALID_ARGUMENT");
  });
});
