import { ExplorerError } from "../domain/errors.ts";

/** 插件专属 origin 与 realm 前缀，保证只读写本插件自己的登录条目。 */
export const CREDENTIAL_ORIGIN = "chrome://zotero-topic-explorer";
export const CREDENTIAL_REALM_PREFIX = "zotero-topic-explorer:";
const LOGIN_INFO_CONTRACT = "@mozilla.org/login-manager/loginInfo;1";
const CONFIG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_KEY_LENGTH = 4_096;

/** nsILoginInfo 的最小子集。 */
export interface LoginInfoLike {
  origin?: string;
  httpRealm?: string | null;
  username?: string;
  password: string;
  init(
    origin: string,
    formActionOrigin: string | null,
    httpRealm: string | null,
    username: string,
    password: string,
    usernameField?: string,
    passwordField?: string,
  ): void;
}

/** Services.logins（nsILoginManager）的最小子集。 */
export interface LoginManagerLike {
  initializationPromise?: Promise<unknown>;
  findLogins(
    origin: string,
    formActionOrigin: string | null,
    httpRealm: string | null,
  ): LoginInfoLike[];
  addLoginAsync(login: LoginInfoLike): Promise<unknown>;
  removeLogin(login: LoginInfoLike): void;
}

export interface CredentialStoreOptions {
  /** 注入的登录管理器；`null` 表示不可用（仅会话内存），缺省时从运行时 Services.logins 解析。 */
  loginManager?: LoginManagerLike | null;
  /** 注入的 nsILoginInfo 工厂；缺省通过 Components.classes 创建。 */
  createLoginInfo?: () => LoginInfoLike;
}

interface ComponentsLike {
  classes?: Record<string, { createInstance(iface: unknown): unknown } | undefined>;
  interfaces?: Record<string, unknown>;
}

export function credentialRealm(configId: string): string {
  return `${CREDENTIAL_REALM_PREFIX}${assertConfigId(configId)}`;
}

function assertConfigId(configId: unknown): string {
  if (typeof configId !== "string" || !CONFIG_ID.test(configId)) {
    throw new ExplorerError("INVALID_ARGUMENT", "模型配置 ID 格式无效");
  }
  return configId;
}

function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function assertKey(key: unknown): string {
  if (typeof key !== "string") {
    throw new ExplorerError("INVALID_ARGUMENT", "API 密钥必须是字符串");
  }
  const trimmed = key.trim();
  if (!trimmed) {
    throw new ExplorerError("INVALID_ARGUMENT", "API 密钥不能为空");
  }
  if (trimmed.length > MAX_KEY_LENGTH || hasControlChars(trimmed)) {
    throw new ExplorerError("INVALID_ARGUMENT", "API 密钥过长或包含非法字符");
  }
  return trimmed;
}

function runtimeLoginManager(): LoginManagerLike | null {
  const services = (globalThis as { Services?: { logins?: unknown } }).Services;
  const logins = services?.logins as Partial<LoginManagerLike> | undefined;
  if (
    !logins ||
    typeof logins.findLogins !== "function" ||
    typeof logins.addLoginAsync !== "function" ||
    typeof logins.removeLogin !== "function"
  ) {
    return null;
  }
  return logins as LoginManagerLike;
}

function runtimeCreateLoginInfo(): LoginInfoLike {
  const components = (globalThis as { Components?: ComponentsLike }).Components;
  const factory = components?.classes?.[LOGIN_INFO_CONTRACT];
  const iface = components?.interfaces?.nsILoginInfo;
  if (!factory || !iface) {
    throw new ExplorerError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      "无法创建登录条目，凭据未保存",
    );
  }
  return factory.createInstance(iface) as LoginInfoLike;
}

/**
 * API 密钥存储。
 * - persist=true 且 Login Manager 可用：写入 Firefox Login Manager（受主密码保护的加密存储）。
 * - persist=false 或 Login Manager 不可用：仅保存在会话内存 Map，插件卸载即消失。
 * - 绝不写入偏好、明文文件或日志；持久化失败时抛错而不是降级为明文。
 */
export class CredentialStore {
  private readonly session = new Map<string, string>();
  private readonly loginManagerOption: LoginManagerLike | null | undefined;
  private readonly createLoginInfo: () => LoginInfoLike;

  constructor(options: CredentialStoreOptions = {}) {
    this.loginManagerOption = options.loginManager;
    this.createLoginInfo = options.createLoginInfo ?? runtimeCreateLoginInfo;
  }

  /** Login Manager 是否可用；不可用时所有密钥仅在会话内存中。 */
  get persistenceAvailable(): boolean {
    return this.loginManager() !== null;
  }

  private loginManager(): LoginManagerLike | null {
    if (this.loginManagerOption !== undefined) {
      return this.loginManagerOption;
    }
    return runtimeLoginManager();
  }

  private async ready(manager: LoginManagerLike): Promise<void> {
    if (manager.initializationPromise) {
      try {
        await manager.initializationPromise;
      } catch {
        throw new ExplorerError(
          "CREDENTIAL_STORE_UNAVAILABLE",
          "Login Manager 初始化失败",
        );
      }
    }
  }

  /** 只返回本插件 origin 与该配置 realm 完全匹配的条目。 */
  private ownLogins(manager: LoginManagerLike, realm: string): LoginInfoLike[] {
    const found = manager.findLogins(CREDENTIAL_ORIGIN, null, realm) ?? [];
    return found.filter(
      (login) =>
        login &&
        (login.origin === undefined || login.origin === CREDENTIAL_ORIGIN) &&
        (login.httpRealm === undefined || login.httpRealm === realm),
    );
  }

  async get(configId: string): Promise<string> {
    const id = assertConfigId(configId);
    const inSession = this.session.get(id);
    if (inSession !== undefined) {
      return inSession;
    }
    const manager = this.loginManager();
    if (!manager) {
      throw new ExplorerError("CREDENTIAL_MISSING", "尚未为该模型配置 API 密钥");
    }
    let logins: LoginInfoLike[];
    try {
      await this.ready(manager);
      logins = this.ownLogins(manager, credentialRealm(id));
    } catch (error) {
      if (error instanceof ExplorerError) {
        throw error;
      }
      throw new ExplorerError("CREDENTIAL_READ_FAILED", "读取已保存的 API 密钥失败");
    }
    const match = logins.find(
      (login) => typeof login.password === "string" && login.password.length > 0,
    );
    if (!match) {
      throw new ExplorerError("CREDENTIAL_MISSING", "尚未为该模型配置 API 密钥");
    }
    return match.password;
  }

  async has(configId: string): Promise<boolean> {
    try {
      await this.get(configId);
      return true;
    } catch (error) {
      if (error instanceof ExplorerError && error.code === "CREDENTIAL_MISSING") {
        return false;
      }
      throw error;
    }
  }

  async set(configId: string, key: string, persist = true): Promise<void> {
    const id = assertConfigId(configId);
    const secret = assertKey(key);
    const manager = persist ? this.loginManager() : null;
    if (!manager) {
      this.session.set(id, secret);
      return;
    }
    const realm = credentialRealm(id);
    try {
      await this.ready(manager);
      for (const existing of this.ownLogins(manager, realm)) {
        manager.removeLogin(existing);
      }
      const login = this.createLoginInfo();
      login.init(CREDENTIAL_ORIGIN, null, realm, id, secret, "", "");
      await manager.addLoginAsync(login);
    } catch (error) {
      // 持久化失败：不把密钥留在任何地方，也不降级为明文存储。
      this.session.delete(id);
      if (error instanceof ExplorerError) {
        throw error;
      }
      throw new ExplorerError(
        "CREDENTIAL_PERSIST_FAILED",
        "保存 API 密钥到 Login Manager 失败；可改为仅本次会话使用",
      );
    }
    this.session.delete(id);
  }

  async remove(configId: string): Promise<void> {
    const id = assertConfigId(configId);
    this.session.delete(id);
    const manager = this.loginManager();
    if (!manager) {
      return;
    }
    try {
      await this.ready(manager);
      for (const existing of this.ownLogins(manager, credentialRealm(id))) {
        manager.removeLogin(existing);
      }
    } catch (error) {
      if (error instanceof ExplorerError) {
        throw error;
      }
      throw new ExplorerError("CREDENTIAL_REMOVE_FAILED", "删除已保存的 API 密钥失败");
    }
  }

  /** 清空会话内存中的密钥（例如插件关闭时）。不影响 Login Manager。 */
  clearSession(): void {
    this.session.clear();
  }
}
