import type {
  Attachment,
  AuditLog,
  Cipher,
  CustomEquivalentDomain,
  Device,
  Folder,
  Invite,
  RefreshTokenRecord,
  Send,
  TrustedDeviceTokenSummary,
  User,
  UserDomainSettings,
} from '../types';
import { LIMITS } from '../config/limits';
import { normalizeCustomEquivalentDomains, normalizeEquivalentDomains } from './domain-rules';

export interface EdgeOneBlobStore {
  set(key: string, value: string | ArrayBuffer | Blob | ReadableStream, options?: { onlyIfNew?: boolean }): Promise<void>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
  get<T = unknown>(
    key: string,
    options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream'; consistency?: 'eventual' | 'strong' }
  ): Promise<T | null>;
  getWithHeaders?(
    key: string,
    options?: { consistency?: 'eventual' | 'strong' }
  ): Promise<{ body: string; headers: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
  createUploadUrl?(
    key: string,
    options?: { expireSeconds?: number; contentType?: string }
  ): Promise<{ url: string; key: string; expiresAt: number }>;
}

export interface EdgeOneStorageBinding {
  __nodewardenEdgeOneStorage: true;
  dataStore: EdgeOneBlobStore;
  attachmentStore: EdgeOneBlobStore;
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface EdgeOneState {
  version: 1;
  config: Record<string, string>;
  users: Record<string, User>;
  domainSettings: Record<string, UserDomainSettings>;
  revisions: Record<string, string>;
  folders: Record<string, Folder>;
  ciphers: Record<string, Cipher>;
  attachments: Record<string, Attachment>;
  sends: Record<string, Send>;
  refreshTokens: Record<string, RefreshTokenRecord>;
  devices: Record<string, Device>;
  trustedTwoFactorDeviceTokens: Record<string, {
    userId: string;
    deviceIdentifier: string;
    expiresAt: number;
  }>;
  invites: Record<string, Invite>;
  auditLogs: Record<string, AuditLog>;
  usedAttachmentDownloadTokens: Record<string, number>;
  loginAttemptsIp: Record<string, {
    attempts: number;
    lockedUntil: number | null;
    updatedAt: number;
  }>;
  rateLimitWindows: Record<string, {
    count: number;
    expiresAt: number;
  }>;
}

const STATE_KEY = 'state/nodewarden.json';
const EDGEONE_SCHEMA_VERSION_KEY = 'schema.version';
const EDGEONE_SCHEMA_VERSION = '2026-06-04-edgeone-blob-document';
const TWO_FACTOR_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createEdgeOneStorageBinding(
  dataStore: EdgeOneBlobStore,
  attachmentStore: EdgeOneBlobStore = dataStore
): EdgeOneStorageBinding {
  const binding = {
    __nodewardenEdgeOneStorage: true,
    dataStore,
    attachmentStore,
  } as EdgeOneStorageBinding;
  binding.prepare = (sql: string) => new EdgeOneD1PreparedStatement(binding, sql) as unknown as D1PreparedStatement;
  binding.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const out: D1Result<T>[] = [];
    for (const statement of statements) {
      out.push(await statement.run<T>());
    }
    return out;
  };
  return binding;
}

export function isEdgeOneStorageBinding(value: unknown): value is EdgeOneStorageBinding {
  return !!value && typeof value === 'object' && (value as EdgeOneStorageBinding).__nodewardenEdgeOneStorage === true;
}

function emptyState(): EdgeOneState {
  return {
    version: 1,
    config: {},
    users: {},
    domainSettings: {},
    revisions: {},
    folders: {},
    ciphers: {},
    attachments: {},
    sends: {},
    refreshTokens: {},
    devices: {},
    trustedTwoFactorDeviceTokens: {},
    invites: {},
    auditLogs: {},
    usedAttachmentDownloadTokens: {},
    loginAttemptsIp: {},
    rateLimitWindows: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function normalizeState(value: unknown): EdgeOneState {
  const next = emptyState();
  if (!value || typeof value !== 'object') return next;
  const raw = value as Partial<EdgeOneState>;
  return {
    ...next,
    version: 1,
    config: normalizeRecord<string>(raw.config),
    users: normalizeRecord<User>(raw.users),
    domainSettings: normalizeRecord<UserDomainSettings>(raw.domainSettings),
    revisions: normalizeRecord<string>(raw.revisions),
    folders: normalizeRecord<Folder>(raw.folders),
    ciphers: normalizeRecord<Cipher>(raw.ciphers),
    attachments: normalizeRecord<Attachment>(raw.attachments),
    sends: normalizeRecord<Send>(raw.sends),
    refreshTokens: normalizeRecord<RefreshTokenRecord>(raw.refreshTokens),
    devices: normalizeRecord<Device>(raw.devices),
    trustedTwoFactorDeviceTokens: normalizeRecord<EdgeOneState['trustedTwoFactorDeviceTokens'][string]>(raw.trustedTwoFactorDeviceTokens),
    invites: normalizeRecord<Invite>(raw.invites),
    auditLogs: normalizeRecord<AuditLog>(raw.auditLogs),
    usedAttachmentDownloadTokens: normalizeRecord<number>(raw.usedAttachmentDownloadTokens),
    loginAttemptsIp: normalizeRecord<EdgeOneState['loginAttemptsIp'][string]>(raw.loginAttemptsIp),
    rateLimitWindows: normalizeRecord<EdgeOneState['rateLimitWindows'][string]>(raw.rateLimitWindows),
  };
}

async function loadEdgeOneState(binding: EdgeOneStorageBinding): Promise<EdgeOneState> {
  const raw = await binding.dataStore.get(STATE_KEY, { type: 'json', consistency: 'strong' });
  return normalizeState(raw);
}

async function saveEdgeOneState(binding: EdgeOneStorageBinding, state: EdgeOneState): Promise<void> {
  await binding.dataStore.setJSON(STATE_KEY, state);
}

async function mutateEdgeOneState<T>(
  binding: EdgeOneStorageBinding,
  mutator: (state: EdgeOneState) => T | Promise<T>
): Promise<T> {
  const state = await loadEdgeOneState(binding);
  const result = await mutator(state);
  await saveEdgeOneState(binding, state);
  return result;
}

function sortByIsoDesc<T>(items: T[], select: (item: T) => string | null | undefined): T[] {
  return items.sort((a, b) => String(select(b) || '').localeCompare(String(select(a) || '')));
}

function sanitizeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function normalizeOptionalId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function userToSqlRow(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    master_password_hint: user.masterPasswordHint,
    master_password_hash: user.masterPasswordHash,
    key: user.key,
    private_key: user.privateKey,
    public_key: user.publicKey,
    kdf_type: user.kdfType,
    kdf_iterations: user.kdfIterations,
    kdf_memory: user.kdfMemory ?? null,
    kdf_parallelism: user.kdfParallelism ?? null,
    security_stamp: user.securityStamp,
    role: user.role,
    status: user.status,
    verify_devices: user.verifyDevices === false ? 0 : 1,
    totp_secret: user.totpSecret,
    totp_recovery_code: user.totpRecoveryCode,
    api_key: user.apiKey,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

function folderToSqlRow(folder: Folder): Record<string, unknown> {
  return {
    id: folder.id,
    user_id: folder.userId,
    name: folder.name,
    created_at: folder.createdAt,
    updated_at: folder.updatedAt,
  };
}

function cipherToSqlRow(cipher: Cipher): Record<string, unknown> {
  return {
    id: cipher.id,
    user_id: cipher.userId,
    type: cipher.type,
    folder_id: cipher.folderId,
    name: cipher.name,
    notes: cipher.notes,
    favorite: cipher.favorite ? 1 : 0,
    data: JSON.stringify(cipher),
    reprompt: cipher.reprompt,
    key: cipher.key,
    created_at: cipher.createdAt,
    updated_at: cipher.updatedAt,
    archived_at: cipher.archivedAt,
    deleted_at: cipher.deletedAt,
  };
}

function attachmentToSqlRow(attachment: Attachment): Record<string, unknown> {
  return {
    id: attachment.id,
    cipher_id: attachment.cipherId,
    file_name: attachment.fileName,
    size: attachment.size,
    size_name: attachment.sizeName,
    key: attachment.key,
  };
}

function domainSettingsToSqlRow(settings: UserDomainSettings): Record<string, unknown> {
  return {
    user_id: settings.userId,
    equivalent_domains: JSON.stringify(settings.equivalentDomains),
    custom_equivalent_domains: JSON.stringify(settings.customEquivalentDomains),
    excluded_global_equivalent_domains: JSON.stringify(settings.excludedGlobalEquivalentDomains),
    updated_at: settings.updatedAt,
  };
}

function extractJsonToken(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

function extractJsonExpiresAt(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { expiresAtMs?: unknown };
    const expiresAt = Number(parsed.expiresAtMs || 0);
    return Number.isFinite(expiresAt) ? expiresAt : 0;
  } catch {
    return 0;
  }
}

class EdgeOneD1PreparedStatement {
  constructor(
    private binding: EdgeOneStorageBinding,
    private sql: string,
    private values: unknown[] = []
  ) {}

  bind(...values: unknown[]): EdgeOneD1PreparedStatement {
    return new EdgeOneD1PreparedStatement(this.binding, this.sql, values);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const changes = await this.runMutation();
    return {
      results: [],
      success: true,
      meta: { changes },
    } as unknown as D1Result<T>;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const results = await this.queryRows<T>();
    return {
      results,
      success: true,
      meta: {},
    } as unknown as D1Result<T>;
  }

  async first<T = unknown>(): Promise<T | null> {
    const results = await this.queryRows<T>();
    return results[0] ?? null;
  }

  private normalizedSql(): string {
    return this.sql.replace(/\s+/g, ' ').trim();
  }

  private async runMutation(): Promise<number> {
    const sql = this.normalizedSql();
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS config')) return 0;

    if (sql.startsWith('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE')) {
      const [key, value, nowMs] = this.values;
      return mutateEdgeOneState(this.binding, (state) => {
        const configKey = String(key || '');
        const current = state.config[configKey];
        if (current && extractJsonExpiresAt(current) > Number(nowMs || 0)) return 0;
        state.config[configKey] = String(value ?? '');
        return 1;
      });
    }

    if (sql.startsWith('UPDATE config SET value = ? WHERE key = ? AND json_extract(value,')) {
      const [value, key, token] = this.values;
      return mutateEdgeOneState(this.binding, (state) => {
        const configKey = String(key || '');
        if (extractJsonToken(state.config[configKey]) !== String(token || '')) return 0;
        state.config[configKey] = String(value ?? '');
        return 1;
      });
    }

    if (sql.startsWith('DELETE FROM config WHERE key = ? AND json_extract(value,')) {
      const [key, token] = this.values;
      return mutateEdgeOneState(this.binding, (state) => {
        const configKey = String(key || '');
        if (extractJsonToken(state.config[configKey]) !== String(token || '')) return 0;
        delete state.config[configKey];
        return 1;
      });
    }

    throw new Error(`EdgeOne Blob storage does not support this SQL mutation: ${sql}`);
  }

  private async queryRows<T>(): Promise<T[]> {
    const sql = this.normalizedSql();
    const state = await loadEdgeOneState(this.binding);

    if (sql === 'SELECT key, value FROM config ORDER BY key ASC') {
      return Object.entries(state.config)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value }) as T);
    }
    if (sql.startsWith('SELECT id, email, name, master_password_hint')) {
      return Object.values(state.users)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((user) => userToSqlRow(user) as T);
    }
    if (sql.startsWith('SELECT user_id, equivalent_domains')) {
      return Object.values(state.domainSettings)
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .map((settings) => domainSettingsToSqlRow(settings) as T);
    }
    if (sql === 'SELECT user_id, revision_date FROM user_revisions ORDER BY user_id ASC') {
      return Object.entries(state.revisions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([user_id, revision_date]) => ({ user_id, revision_date }) as T);
    }
    if (sql === 'SELECT id, user_id, name, created_at, updated_at FROM folders ORDER BY created_at ASC') {
      return Object.values(state.folders)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((folder) => folderToSqlRow(folder) as T);
    }
    if (sql.startsWith('SELECT id, user_id, type, folder_id')) {
      return Object.values(state.ciphers)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((cipher) => cipherToSqlRow(cipher) as T);
    }
    if (sql === 'SELECT id, cipher_id, file_name, size, size_name, key FROM attachments ORDER BY cipher_id ASC, id ASC') {
      return Object.values(state.attachments)
        .sort((a, b) => `${a.cipherId}:${a.id}`.localeCompare(`${b.cipherId}:${b.id}`))
        .map((attachment) => attachmentToSqlRow(attachment) as T);
    }

    throw new Error(`EdgeOne Blob storage does not support this SQL query: ${sql}`);
  }
}

export class EdgeOneBlobStorageService {
  constructor(private binding: EdgeOneStorageBinding) {}

  private async loadState(): Promise<EdgeOneState> {
    return loadEdgeOneState(this.binding);
  }

  private async saveState(state: EdgeOneState): Promise<void> {
    await saveEdgeOneState(this.binding, state);
  }

  private async mutateState<T>(mutator: (state: EdgeOneState) => T | Promise<T>): Promise<T> {
    const state = await this.loadState();
    const result = await mutator(state);
    await this.saveState(state);
    return result;
  }

  private async sha256Hex(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private async refreshTokenKey(token: string): Promise<string> {
    return `sha256:${await this.sha256Hex(token)}`;
  }

  private async trustedTwoFactorTokenKey(token: string): Promise<string> {
    return `sha256:${await this.sha256Hex(token)}`;
  }

  async initializeDatabase(): Promise<void> {
    await this.mutateState((state) => {
      state.config[EDGEONE_SCHEMA_VERSION_KEY] = EDGEONE_SCHEMA_VERSION;
    });
  }

  async isRegistered(): Promise<boolean> {
    const state = await this.loadState();
    return state.config.registered === 'true';
  }

  async getConfigValue(key: string): Promise<string | null> {
    const state = await this.loadState();
    return state.config[key] ?? null;
  }

  async setConfigValue(key: string, value: string): Promise<void> {
    await this.mutateState((state) => {
      state.config[key] = value;
    });
  }

  async setRegistered(): Promise<void> {
    await this.setConfigValue('registered', 'true');
  }

  async getUser(email: string): Promise<User | null> {
    const normalized = email.toLowerCase();
    const state = await this.loadState();
    return clone(Object.values(state.users).find((user) => user.email.toLowerCase() === normalized) ?? null);
  }

  async getUserById(id: string): Promise<User | null> {
    const state = await this.loadState();
    return clone(state.users[id] ?? null);
  }

  async getUserCount(): Promise<number> {
    const state = await this.loadState();
    return Object.keys(state.users).length;
  }

  async getAllUsers(): Promise<User[]> {
    const state = await this.loadState();
    return clone(Object.values(state.users).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async saveUser(user: User): Promise<void> {
    await this.mutateState((state) => {
      state.users[user.id] = clone({ ...user, email: user.email.toLowerCase() });
    });
  }

  async createUser(user: User): Promise<void> {
    await this.saveUser(user);
  }

  async createFirstUser(user: User): Promise<boolean> {
    return this.mutateState((state) => {
      if (Object.keys(state.users).length > 0) return false;
      state.users[user.id] = clone({ ...user, email: user.email.toLowerCase() });
      return true;
    });
  }

  async deleteUserById(id: string): Promise<boolean> {
    return this.mutateState((state) => {
      if (!state.users[id]) return false;
      delete state.users[id];
      delete state.domainSettings[id];
      delete state.revisions[id];
      for (const key of Object.keys(state.folders)) {
        if (state.folders[key].userId === id) delete state.folders[key];
      }
      for (const key of Object.keys(state.ciphers)) {
        if (state.ciphers[key].userId === id) {
          delete state.ciphers[key];
          for (const attachmentKey of Object.keys(state.attachments)) {
            if (state.attachments[attachmentKey].cipherId === key) delete state.attachments[attachmentKey];
          }
        }
      }
      for (const key of Object.keys(state.sends)) {
        if (state.sends[key].userId === id) delete state.sends[key];
      }
      for (const key of Object.keys(state.devices)) {
        if (state.devices[key].userId === id) delete state.devices[key];
      }
      for (const key of Object.keys(state.refreshTokens)) {
        if (state.refreshTokens[key].userId === id) delete state.refreshTokens[key];
      }
      for (const key of Object.keys(state.trustedTwoFactorDeviceTokens)) {
        if (state.trustedTwoFactorDeviceTokens[key].userId === id) delete state.trustedTwoFactorDeviceTokens[key];
      }
      return true;
    });
  }

  async createInvite(invite: Invite): Promise<void> {
    await this.mutateState((state) => {
      state.invites[invite.code] = clone(invite);
    });
  }

  async getInvite(code: string): Promise<Invite | null> {
    const state = await this.loadState();
    return clone(state.invites[code] ?? null);
  }

  async listInvites(includeInactive: boolean = false): Promise<Invite[]> {
    const now = new Date().toISOString();
    const state = await this.loadState();
    const invites = Object.values(state.invites).filter((invite) =>
      includeInactive || (invite.status === 'active' && invite.expiresAt > now)
    );
    return clone(sortByIsoDesc(invites, (invite) => invite.createdAt));
  }

  async markInviteUsed(code: string, userId: string): Promise<boolean> {
    return this.mutateState((state) => {
      const invite = state.invites[code];
      if (!invite || invite.status !== 'active' || invite.expiresAt <= new Date().toISOString()) return false;
      invite.status = 'used';
      invite.usedBy = userId;
      invite.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async revokeInvite(code: string): Promise<boolean> {
    return this.mutateState((state) => {
      const invite = state.invites[code];
      if (!invite || invite.status !== 'active') return false;
      invite.status = 'revoked';
      invite.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async deleteAllInvites(): Promise<number> {
    return this.mutateState((state) => {
      const count = Object.keys(state.invites).length;
      state.invites = {};
      return count;
    });
  }

  async createAuditLog(log: AuditLog): Promise<void> {
    await this.mutateState((state) => {
      state.auditLogs[log.id] = clone(log);
    });
  }

  async listAuditLogs(options: {
    limit: number;
    offset: number;
    category?: string | null;
    level?: string | null;
    q?: string | null;
    from?: string | null;
    to?: string | null;
  }): Promise<{ logs: AuditLog[]; total: number; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const q = String(options.q || '').trim().toLowerCase();
    const state = await this.loadState();
    const rows = Object.values(state.auditLogs).filter((log) => {
      if (options.from && log.createdAt < options.from) return false;
      if (options.to && log.createdAt > options.to) return false;
      if (options.category && log.category !== options.category) return false;
      if (options.level && log.level !== options.level) return false;
      if (!q) return true;
      const actorEmail = log.actorUserId ? state.users[log.actorUserId]?.email || '' : '';
      const targetEmail = log.targetType === 'user' && log.targetId ? state.users[log.targetId]?.email || '' : '';
      return [log.action, log.actorUserId, log.targetType, log.targetId, actorEmail, targetEmail]
        .some((value) => String(value || '').toLowerCase().includes(q));
    });
    const sorted = sortByIsoDesc(rows, (log) => log.createdAt);
    const page = sorted.slice(offset, offset + limit + 1);
    const logs = page.slice(0, limit).map((log) => ({
      ...log,
      actorEmail: log.actorUserId ? state.users[log.actorUserId]?.email ?? null : null,
      targetUserEmail: log.targetType === 'user' && log.targetId ? state.users[log.targetId]?.email ?? null : null,
    }));
    return {
      logs: clone(logs),
      total: offset + logs.length + (page.length > limit ? 1 : 0),
      hasMore: page.length > limit,
    };
  }

  async pruneAuditLogs(beforeIso: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.auditLogs)) {
        if (state.auditLogs[key].createdAt < beforeIso) {
          delete state.auditLogs[key];
          count++;
        }
      }
      return count;
    });
  }

  async pruneAuditLogsToMax(maxEntries: number): Promise<number> {
    return this.mutateState((state) => {
      const keep = Math.max(1, Math.floor(maxEntries));
      const sorted = sortByIsoDesc(Object.values(state.auditLogs), (log) => log.createdAt);
      const remove = sorted.slice(keep);
      for (const log of remove) delete state.auditLogs[log.id];
      return remove.length;
    });
  }

  async clearAuditLogs(): Promise<number> {
    return this.mutateState((state) => {
      const count = Object.keys(state.auditLogs).length;
      state.auditLogs = {};
      return count;
    });
  }

  async getUserDomainSettings(userId: string): Promise<UserDomainSettings> {
    const state = await this.loadState();
    const existing = state.domainSettings[userId];
    if (existing) return clone(existing);
    return {
      userId,
      equivalentDomains: [],
      customEquivalentDomains: [],
      excludedGlobalEquivalentDomains: [],
      updatedAt: null,
    };
  }

  async saveUserDomainSettings(
    userId: string,
    equivalentDomains: string[][],
    customEquivalentDomains: CustomEquivalentDomain[],
    excludedGlobalEquivalentDomains: number[]
  ): Promise<void> {
    await this.mutateState((state) => {
      state.domainSettings[userId] = {
        userId,
        equivalentDomains: normalizeEquivalentDomains(equivalentDomains),
        customEquivalentDomains: normalizeCustomEquivalentDomains(customEquivalentDomains),
        excludedGlobalEquivalentDomains: excludedGlobalEquivalentDomains.filter((value) => Number.isFinite(value)),
        updatedAt: new Date().toISOString(),
      };
      state.revisions[userId] = new Date().toISOString();
    });
  }

  async getCipher(id: string): Promise<Cipher | null> {
    const state = await this.loadState();
    return clone(state.ciphers[id] ?? null);
  }

  async saveCipher(cipher: Cipher): Promise<void> {
    await this.mutateState((state) => {
      state.ciphers[cipher.id] = clone({ ...cipher, folderId: normalizeOptionalId(cipher.folderId) });
    });
  }

  async importVaultData(folders: Folder[], ciphers: Cipher[], userId: string): Promise<string> {
    return this.mutateState((state) => {
      for (const folder of folders) {
        state.folders[folder.id] = clone(folder);
      }
      for (const cipher of ciphers) {
        state.ciphers[cipher.id] = clone({ ...cipher, folderId: normalizeOptionalId(cipher.folderId) });
      }
      const revisionDate = new Date().toISOString();
      state.revisions[userId] = revisionDate;
      return revisionDate;
    });
  }

  async deleteCipher(id: string, userId: string): Promise<void> {
    await this.mutateState((state) => {
      const cipher = state.ciphers[id];
      if (!cipher || cipher.userId !== userId) return;
      delete state.ciphers[id];
      for (const attachmentId of Object.keys(state.attachments)) {
        if (state.attachments[attachmentId].cipherId === id) delete state.attachments[attachmentId];
      }
    });
  }

  async bulkSoftDeleteCiphers(ids: string[], userId: string): Promise<string | null> {
    return this.updateCiphers(ids, userId, (cipher, now) => {
      cipher.deletedAt = now;
      cipher.updatedAt = now;
    });
  }

  async bulkRestoreCiphers(ids: string[], userId: string): Promise<string | null> {
    return this.updateCiphers(ids, userId, (cipher, now) => {
      cipher.deletedAt = null;
      cipher.updatedAt = now;
    });
  }

  async bulkArchiveCiphers(ids: string[], userId: string): Promise<string | null> {
    return this.updateCiphers(ids, userId, (cipher, now) => {
      if (cipher.deletedAt) return;
      cipher.archivedAt = now;
      cipher.updatedAt = now;
    });
  }

  async bulkUnarchiveCiphers(ids: string[], userId: string): Promise<string | null> {
    return this.updateCiphers(ids, userId, (cipher, now) => {
      cipher.archivedAt = null;
      cipher.updatedAt = now;
    });
  }

  async bulkDeleteCiphers(ids: string[], userId: string): Promise<string | null> {
    const uniqueIds = sanitizeIds(ids);
    if (!uniqueIds.length) return null;
    return this.mutateState((state) => {
      let changed = false;
      for (const id of uniqueIds) {
        const cipher = state.ciphers[id];
        if (!cipher || cipher.userId !== userId) continue;
        delete state.ciphers[id];
        for (const attachmentId of Object.keys(state.attachments)) {
          if (state.attachments[attachmentId].cipherId === id) delete state.attachments[attachmentId];
        }
        changed = true;
      }
      if (!changed) return null;
      const revisionDate = new Date().toISOString();
      state.revisions[userId] = revisionDate;
      return revisionDate;
    });
  }

  private async updateCiphers(
    ids: string[],
    userId: string,
    updater: (cipher: Cipher, now: string) => void
  ): Promise<string | null> {
    const uniqueIds = sanitizeIds(ids);
    if (!uniqueIds.length) return null;
    return this.mutateState((state) => {
      const now = new Date().toISOString();
      let changed = false;
      for (const id of uniqueIds) {
        const cipher = state.ciphers[id];
        if (!cipher || cipher.userId !== userId) continue;
        updater(cipher, now);
        changed = true;
      }
      if (!changed) return null;
      state.revisions[userId] = now;
      return now;
    });
  }

  async getAllCiphers(userId: string): Promise<Cipher[]> {
    const state = await this.loadState();
    return clone(sortByIsoDesc(
      Object.values(state.ciphers).filter((cipher) => cipher.userId === userId),
      (cipher) => cipher.updatedAt
    ));
  }

  async getCiphersPage(userId: string, includeDeleted: boolean, limit: number, offset: number): Promise<Cipher[]> {
    const ciphers = (await this.getAllCiphers(userId)).filter((cipher) => includeDeleted || !cipher.deletedAt);
    return ciphers.slice(offset, offset + limit);
  }

  async getCiphersByIds(ids: string[], userId: string): Promise<Cipher[]> {
    const idSet = new Set(sanitizeIds(ids));
    const state = await this.loadState();
    return clone(Object.values(state.ciphers).filter((cipher) => cipher.userId === userId && idSet.has(cipher.id)));
  }

  async bulkMoveCiphers(ids: string[], folderId: string | null, userId: string): Promise<string | null> {
    const normalizedFolderId = normalizeOptionalId(folderId);
    return this.updateCiphers(ids, userId, (cipher, now) => {
      cipher.folderId = normalizedFolderId;
      cipher.updatedAt = now;
    });
  }

  async getFolder(id: string): Promise<Folder | null> {
    const state = await this.loadState();
    return clone(state.folders[id] ?? null);
  }

  async saveFolder(folder: Folder): Promise<void> {
    await this.mutateState((state) => {
      state.folders[folder.id] = clone(folder);
    });
  }

  async deleteFolder(id: string, userId: string): Promise<void> {
    await this.mutateState((state) => {
      const folder = state.folders[id];
      if (!folder || folder.userId !== userId) return;
      delete state.folders[id];
      const now = new Date().toISOString();
      for (const cipher of Object.values(state.ciphers)) {
        if (cipher.userId === userId && cipher.folderId === id) {
          cipher.folderId = null;
          cipher.updatedAt = now;
        }
      }
    });
  }

  async bulkDeleteFolders(ids: string[], userId: string): Promise<string | null> {
    const uniqueIds = sanitizeIds(ids);
    if (!uniqueIds.length) return null;
    const idSet = new Set(uniqueIds);
    return this.mutateState((state) => {
      const now = new Date().toISOString();
      let changed = false;
      for (const id of uniqueIds) {
        const folder = state.folders[id];
        if (!folder || folder.userId !== userId) continue;
        delete state.folders[id];
        changed = true;
      }
      for (const cipher of Object.values(state.ciphers)) {
        if (cipher.userId === userId && cipher.folderId && idSet.has(cipher.folderId)) {
          cipher.folderId = null;
          cipher.updatedAt = now;
        }
      }
      if (!changed) return null;
      state.revisions[userId] = now;
      return now;
    });
  }

  async clearFolderFromCiphers(userId: string, folderId: string): Promise<void> {
    await this.mutateState((state) => {
      const now = new Date().toISOString();
      for (const cipher of Object.values(state.ciphers)) {
        if (cipher.userId === userId && cipher.folderId === folderId) {
          cipher.folderId = null;
          cipher.updatedAt = now;
        }
      }
    });
  }

  async getAllFolders(userId: string): Promise<Folder[]> {
    const state = await this.loadState();
    return clone(sortByIsoDesc(
      Object.values(state.folders).filter((folder) => folder.userId === userId),
      (folder) => folder.updatedAt
    ));
  }

  async getFoldersPage(userId: string, limit: number, offset: number): Promise<Folder[]> {
    return (await this.getAllFolders(userId)).slice(offset, offset + limit);
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    const state = await this.loadState();
    return clone(state.attachments[id] ?? null);
  }

  async saveAttachment(attachment: Attachment): Promise<void> {
    await this.mutateState((state) => {
      state.attachments[attachment.id] = clone(attachment);
    });
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.mutateState((state) => {
      delete state.attachments[id];
    });
  }

  async bulkDeleteAttachmentsByIds(ids: string[]): Promise<void> {
    const uniqueIds = sanitizeIds(ids);
    await this.mutateState((state) => {
      for (const id of uniqueIds) delete state.attachments[id];
    });
  }

  async getAttachmentsByCipher(cipherId: string): Promise<Attachment[]> {
    const state = await this.loadState();
    return clone(Object.values(state.attachments).filter((attachment) => attachment.cipherId === cipherId));
  }

  async getAttachmentsByCipherIds(cipherIds: string[]): Promise<Map<string, Attachment[]>> {
    const idSet = new Set(sanitizeIds(cipherIds));
    const state = await this.loadState();
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of Object.values(state.attachments)) {
      if (!idSet.has(attachment.cipherId)) continue;
      const list = grouped.get(attachment.cipherId);
      if (list) list.push(clone(attachment));
      else grouped.set(attachment.cipherId, [clone(attachment)]);
    }
    return grouped;
  }

  async getAttachmentsByUserId(userId: string): Promise<Map<string, Attachment[]>> {
    const state = await this.loadState();
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of Object.values(state.attachments)) {
      const cipher = state.ciphers[attachment.cipherId];
      if (!cipher || cipher.userId !== userId) continue;
      const list = grouped.get(attachment.cipherId);
      if (list) list.push(clone(attachment));
      else grouped.set(attachment.cipherId, [clone(attachment)]);
    }
    return grouped;
  }

  async addAttachmentToCipher(cipherId: string, attachmentId: string): Promise<void> {
    await this.mutateState((state) => {
      if (state.attachments[attachmentId]) state.attachments[attachmentId].cipherId = cipherId;
    });
  }

  async deleteAllAttachmentsByCipher(cipherId: string): Promise<void> {
    await this.mutateState((state) => {
      for (const id of Object.keys(state.attachments)) {
        if (state.attachments[id].cipherId === cipherId) delete state.attachments[id];
      }
    });
  }

  async updateCipherRevisionDate(cipherId: string): Promise<{ userId: string; revisionDate: string } | null> {
    return this.mutateState((state) => {
      const cipher = state.ciphers[cipherId];
      if (!cipher) return null;
      const now = new Date().toISOString();
      cipher.updatedAt = now;
      state.revisions[cipher.userId] = now;
      return { userId: cipher.userId, revisionDate: now };
    });
  }

  async saveRefreshToken(
    token: string,
    userId: string,
    expiresAtMs: number = Date.now() + LIMITS.auth.refreshTokenTtlMs,
    deviceIdentifier?: string | null,
    deviceSessionStamp?: string | null
  ): Promise<void> {
    const key = await this.refreshTokenKey(token);
    await this.mutateState((state) => {
      this.deleteExpiredRefreshTokens(state);
      state.refreshTokens[key] = {
        userId,
        expiresAt: expiresAtMs,
        deviceIdentifier: deviceIdentifier ?? null,
        deviceSessionStamp: deviceSessionStamp ?? null,
      };
    });
  }

  async getRefreshTokenRecord(token: string): Promise<RefreshTokenRecord | null> {
    const key = await this.refreshTokenKey(token);
    return this.mutateState((state) => {
      this.deleteExpiredRefreshTokens(state);
      const record = state.refreshTokens[key] ?? state.refreshTokens[token];
      if (!record) return null;
      if (record.expiresAt && record.expiresAt < Date.now()) {
        delete state.refreshTokens[key];
        delete state.refreshTokens[token];
        return null;
      }
      return clone(record);
    });
  }

  async getRefreshTokenUserId(token: string): Promise<string | null> {
    const record = await this.getRefreshTokenRecord(token);
    return record?.userId ?? null;
  }

  async deleteRefreshToken(token: string): Promise<void> {
    const key = await this.refreshTokenKey(token);
    await this.mutateState((state) => {
      delete state.refreshTokens[key];
      delete state.refreshTokens[token];
    });
  }

  async deleteRefreshTokensByUserId(userId: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.refreshTokens)) {
        if (state.refreshTokens[key].userId === userId) {
          delete state.refreshTokens[key];
          count++;
        }
      }
      return count;
    });
  }

  async deleteRefreshTokensByDevice(userId: string, deviceIdentifier: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.refreshTokens)) {
        const record = state.refreshTokens[key];
        if (record.userId === userId && record.deviceIdentifier === deviceIdentifier) {
          delete state.refreshTokens[key];
          count++;
        }
      }
      return count;
    });
  }

  async constrainRefreshTokenExpiry(token: string, maxExpiresAtMs: number): Promise<void> {
    const key = await this.refreshTokenKey(token);
    await this.mutateState((state) => {
      for (const tokenKey of [key, token]) {
        const record = state.refreshTokens[tokenKey];
        if (record && record.expiresAt > maxExpiresAtMs) record.expiresAt = maxExpiresAtMs;
      }
    });
  }

  private deleteExpiredRefreshTokens(state: EdgeOneState): void {
    const now = Date.now();
    for (const key of Object.keys(state.refreshTokens)) {
      if (state.refreshTokens[key].expiresAt < now) delete state.refreshTokens[key];
    }
  }

  async getSend(id: string): Promise<Send | null> {
    const state = await this.loadState();
    return clone(state.sends[id] ?? null);
  }

  async saveSend(send: Send): Promise<void> {
    await this.mutateState((state) => {
      state.sends[send.id] = clone(send);
    });
  }

  async incrementSendAccessCount(sendId: string): Promise<boolean> {
    return this.mutateState((state) => {
      const send = state.sends[sendId];
      if (!send) return false;
      if (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount) return false;
      send.accessCount += 1;
      send.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async deleteSend(id: string, userId: string): Promise<void> {
    await this.mutateState((state) => {
      const send = state.sends[id];
      if (send?.userId === userId) delete state.sends[id];
    });
  }

  async getSendsByIds(ids: string[], userId: string): Promise<Send[]> {
    const idSet = new Set(sanitizeIds(ids));
    const state = await this.loadState();
    return clone(Object.values(state.sends).filter((send) => send.userId === userId && idSet.has(send.id)));
  }

  async bulkDeleteSends(ids: string[], userId: string): Promise<string | null> {
    const uniqueIds = sanitizeIds(ids);
    if (!uniqueIds.length) return null;
    return this.mutateState((state) => {
      let changed = false;
      for (const id of uniqueIds) {
        const send = state.sends[id];
        if (!send || send.userId !== userId) continue;
        delete state.sends[id];
        changed = true;
      }
      if (!changed) return null;
      const revisionDate = new Date().toISOString();
      state.revisions[userId] = revisionDate;
      return revisionDate;
    });
  }

  async getAllSends(userId: string): Promise<Send[]> {
    const state = await this.loadState();
    return clone(sortByIsoDesc(
      Object.values(state.sends).filter((send) => send.userId === userId),
      (send) => send.updatedAt
    ));
  }

  async getSendsPage(userId: string, limit: number, offset: number): Promise<Send[]> {
    return (await this.getAllSends(userId)).slice(offset, offset + limit);
  }

  async upsertDevice(
    userId: string,
    deviceIdentifier: string,
    name: string,
    type: number,
    sessionStamp?: string,
    keys?: {
      encryptedUserKey?: string | null;
      encryptedPublicKey?: string | null;
      encryptedPrivateKey?: string | null;
    }
  ): Promise<void> {
    await this.mutateState((state) => {
      const key = `${userId}:${deviceIdentifier}`;
      const existing = state.devices[key];
      const now = new Date().toISOString();
      state.devices[key] = {
        userId,
        deviceIdentifier,
        name: String(name || '').trim() || existing?.name || '',
        deviceNote: existing?.deviceNote ?? null,
        type,
        sessionStamp: String(sessionStamp || '').trim() || existing?.sessionStamp || '',
        encryptedUserKey: keys?.encryptedUserKey ?? existing?.encryptedUserKey ?? null,
        encryptedPublicKey: keys?.encryptedPublicKey ?? existing?.encryptedPublicKey ?? null,
        encryptedPrivateKey: keys?.encryptedPrivateKey ?? existing?.encryptedPrivateKey ?? null,
        lastSeenAt: now,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
    });
  }

  async isKnownDevice(userId: string, deviceIdentifier: string): Promise<boolean> {
    const state = await this.loadState();
    return !!state.devices[`${userId}:${deviceIdentifier}`];
  }

  async isKnownDeviceByEmail(email: string, deviceIdentifier: string): Promise<boolean> {
    const user = await this.getUser(email);
    return user ? this.isKnownDevice(user.id, deviceIdentifier) : false;
  }

  async getDevicesByUserId(userId: string): Promise<Device[]> {
    const state = await this.loadState();
    const devices = Object.values(state.devices).filter((device) => device.userId === userId);
    devices.sort((a, b) => String(b.lastSeenAt || b.createdAt).localeCompare(String(a.lastSeenAt || a.createdAt)));
    return clone(devices);
  }

  async getDevice(userId: string, deviceIdentifier: string): Promise<Device | null> {
    const state = await this.loadState();
    return clone(state.devices[`${userId}:${deviceIdentifier}`] ?? null);
  }

  async updateDeviceKeys(
    userId: string,
    deviceIdentifier: string,
    keys: {
      encryptedUserKey?: string | null;
      encryptedPublicKey?: string | null;
      encryptedPrivateKey?: string | null;
    }
  ): Promise<boolean> {
    return this.mutateState((state) => {
      const device = state.devices[`${userId}:${deviceIdentifier}`];
      if (!device) return false;
      device.encryptedUserKey = keys.encryptedUserKey ?? null;
      device.encryptedPublicKey = keys.encryptedPublicKey ?? null;
      device.encryptedPrivateKey = keys.encryptedPrivateKey ?? null;
      device.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async updateDeviceName(userId: string, deviceIdentifier: string, name: string): Promise<boolean> {
    return this.mutateState((state) => {
      const device = state.devices[`${userId}:${deviceIdentifier}`];
      if (!device) return false;
      device.deviceNote = String(name || '').trim();
      device.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async touchDeviceLastSeen(userId: string, deviceIdentifier: string): Promise<boolean> {
    return this.mutateState((state) => {
      const device = state.devices[`${userId}:${deviceIdentifier}`];
      if (!device) return false;
      device.lastSeenAt = new Date().toISOString();
      return true;
    });
  }

  async clearDeviceKeys(userId: string, deviceIdentifiers: string[]): Promise<number> {
    const ids = sanitizeIds(deviceIdentifiers);
    return this.mutateState((state) => {
      let count = 0;
      for (const deviceIdentifier of ids) {
        const device = state.devices[`${userId}:${deviceIdentifier}`];
        if (!device) continue;
        device.encryptedUserKey = null;
        device.encryptedPublicKey = null;
        device.encryptedPrivateKey = null;
        device.updatedAt = new Date().toISOString();
        count++;
      }
      return count;
    });
  }

  async deleteDevice(userId: string, deviceIdentifier: string): Promise<boolean> {
    return this.mutateState((state) => {
      const key = `${userId}:${deviceIdentifier}`;
      if (!state.devices[key]) return false;
      delete state.devices[key];
      return true;
    });
  }

  async deleteDevicesByUserId(userId: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.devices)) {
        if (state.devices[key].userId === userId) {
          delete state.devices[key];
          count++;
        }
      }
      return count;
    });
  }

  async getTrustedDeviceTokenSummariesByUserId(userId: string): Promise<TrustedDeviceTokenSummary[]> {
    return this.mutateState((state) => {
      this.deleteExpiredTrustedTokens(state);
      const grouped = new Map<string, TrustedDeviceTokenSummary>();
      for (const token of Object.values(state.trustedTwoFactorDeviceTokens)) {
        if (token.userId !== userId) continue;
        const current = grouped.get(token.deviceIdentifier) ?? {
          deviceIdentifier: token.deviceIdentifier,
          expiresAt: 0,
          tokenCount: 0,
        };
        current.expiresAt = Math.max(current.expiresAt, token.expiresAt);
        current.tokenCount += 1;
        grouped.set(token.deviceIdentifier, current);
      }
      return Array.from(grouped.values()).sort((a, b) => b.expiresAt - a.expiresAt);
    });
  }

  async deleteTrustedTwoFactorTokensByDevice(userId: string, deviceIdentifier: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.trustedTwoFactorDeviceTokens)) {
        const token = state.trustedTwoFactorDeviceTokens[key];
        if (token.userId === userId && token.deviceIdentifier === deviceIdentifier) {
          delete state.trustedTwoFactorDeviceTokens[key];
          count++;
        }
      }
      return count;
    });
  }

  async deleteTrustedTwoFactorTokensByUserId(userId: string): Promise<number> {
    return this.mutateState((state) => {
      let count = 0;
      for (const key of Object.keys(state.trustedTwoFactorDeviceTokens)) {
        if (state.trustedTwoFactorDeviceTokens[key].userId === userId) {
          delete state.trustedTwoFactorDeviceTokens[key];
          count++;
        }
      }
      return count;
    });
  }

  async updateTrustedTwoFactorTokensExpiryByDevice(userId: string, deviceIdentifier: string, expiresAtMs: number): Promise<number> {
    return this.mutateState((state) => {
      this.deleteExpiredTrustedTokens(state);
      let count = 0;
      for (const token of Object.values(state.trustedTwoFactorDeviceTokens)) {
        if (token.userId === userId && token.deviceIdentifier === deviceIdentifier) {
          token.expiresAt = expiresAtMs;
          count++;
        }
      }
      return count;
    });
  }

  async saveTrustedTwoFactorDeviceToken(
    token: string,
    userId: string,
    deviceIdentifier: string,
    expiresAtMs: number = Date.now() + TWO_FACTOR_REMEMBER_TTL_MS
  ): Promise<void> {
    const key = await this.trustedTwoFactorTokenKey(token);
    await this.mutateState((state) => {
      this.deleteExpiredTrustedTokens(state);
      state.trustedTwoFactorDeviceTokens[key] = { userId, deviceIdentifier, expiresAt: expiresAtMs };
    });
  }

  async getTrustedTwoFactorDeviceTokenUserId(token: string, deviceIdentifier: string): Promise<string | null> {
    const key = await this.trustedTwoFactorTokenKey(token);
    return this.mutateState((state) => {
      this.deleteExpiredTrustedTokens(state);
      const record = state.trustedTwoFactorDeviceTokens[key];
      if (!record || record.deviceIdentifier !== deviceIdentifier) return null;
      return record.userId;
    });
  }

  private deleteExpiredTrustedTokens(state: EdgeOneState): void {
    const now = Date.now();
    for (const key of Object.keys(state.trustedTwoFactorDeviceTokens)) {
      if (state.trustedTwoFactorDeviceTokens[key].expiresAt < now) delete state.trustedTwoFactorDeviceTokens[key];
    }
  }

  async getRevisionDate(userId: string): Promise<string> {
    return this.mutateState((state) => {
      if (state.revisions[userId]) return state.revisions[userId];
      const now = new Date().toISOString();
      state.revisions[userId] = now;
      return now;
    });
  }

  async updateRevisionDate(userId: string): Promise<string> {
    return this.mutateState((state) => {
      const now = new Date().toISOString();
      state.revisions[userId] = now;
      return now;
    });
  }

  async consumeAttachmentDownloadToken(jti: string, expUnixSeconds: number): Promise<boolean> {
    return this.mutateState((state) => {
      const now = Date.now();
      for (const key of Object.keys(state.usedAttachmentDownloadTokens)) {
        if (state.usedAttachmentDownloadTokens[key] < now) delete state.usedAttachmentDownloadTokens[key];
      }
      if (state.usedAttachmentDownloadTokens[jti]) return false;
      state.usedAttachmentDownloadTokens[jti] = expUnixSeconds * 1000;
      return true;
    });
  }

  async checkLoginAttempt(ip: string): Promise<{ allowed: boolean; remainingAttempts: number; retryAfterSeconds?: number }> {
    const key = ip.trim() || 'unknown';
    return this.mutateState((state) => {
      this.deleteStaleLoginAttempts(state);
      const row = state.loginAttemptsIp[key];
      if (!row) return { allowed: true, remainingAttempts: LIMITS.rateLimit.loginMaxAttempts };
      if (row.lockedUntil && row.lockedUntil > Date.now()) {
        return {
          allowed: false,
          remainingAttempts: 0,
          retryAfterSeconds: Math.ceil((row.lockedUntil - Date.now()) / 1000),
        };
      }
      if (row.lockedUntil && row.lockedUntil <= Date.now()) {
        delete state.loginAttemptsIp[key];
        return { allowed: true, remainingAttempts: LIMITS.rateLimit.loginMaxAttempts };
      }
      return {
        allowed: true,
        remainingAttempts: Math.max(0, LIMITS.rateLimit.loginMaxAttempts - (row.attempts || 0)),
      };
    });
  }

  async recordFailedLogin(ip: string): Promise<{ locked: boolean; retryAfterSeconds?: number }> {
    const key = ip.trim() || 'unknown';
    return this.mutateState((state) => {
      this.deleteStaleLoginAttempts(state);
      const now = Date.now();
      const row = state.loginAttemptsIp[key] ?? { attempts: 0, lockedUntil: null, updatedAt: now };
      row.attempts += 1;
      row.updatedAt = now;
      if (row.attempts >= LIMITS.rateLimit.loginMaxAttempts) {
        row.lockedUntil = now + LIMITS.rateLimit.loginLockoutMinutes * 60 * 1000;
        state.loginAttemptsIp[key] = row;
        return { locked: true, retryAfterSeconds: LIMITS.rateLimit.loginLockoutMinutes * 60 };
      }
      state.loginAttemptsIp[key] = row;
      return { locked: false };
    });
  }

  async clearLoginAttempts(ip: string): Promise<void> {
    const key = ip.trim() || 'unknown';
    await this.mutateState((state) => {
      delete state.loginAttemptsIp[key];
    });
  }

  private deleteStaleLoginAttempts(state: EdgeOneState): void {
    const cutoff = Date.now() - LIMITS.rateLimit.loginIpRetentionMs;
    for (const key of Object.keys(state.loginAttemptsIp)) {
      const row = state.loginAttemptsIp[key];
      if (row.updatedAt < cutoff && (!row.lockedUntil || row.lockedUntil < Date.now())) delete state.loginAttemptsIp[key];
    }
  }

  async consumeBudget(identifier: string, maxRequests: number): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }> {
    return this.consumeBudgetWithWindow(identifier, maxRequests, LIMITS.rateLimit.apiWindowSeconds);
  }

  async consumeBudgetWithWindow(
    identifier: string,
    maxRequests: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds?: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - (nowSec % windowSeconds);
    const windowEnd = windowStart + windowSeconds;
    const key = `${identifier}:${windowSeconds}:${windowStart}`;
    return this.mutateState((state) => {
      for (const staleKey of Object.keys(state.rateLimitWindows)) {
        if (state.rateLimitWindows[staleKey].expiresAt <= nowSec) delete state.rateLimitWindows[staleKey];
      }
      const row = state.rateLimitWindows[key] ?? { count: 0, expiresAt: windowEnd };
      if (row.count >= maxRequests) {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, windowEnd - nowSec) };
      }
      row.count += 1;
      state.rateLimitWindows[key] = row;
      return { allowed: true, remaining: Math.max(0, maxRequests - row.count) };
    });
  }
}
