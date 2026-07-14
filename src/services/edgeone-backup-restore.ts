import {
  parseBackupArchive,
  validateBackupPayloadContents,
  type BackupPayload,
} from './backup-archive';
import type { BackupImportExecutionResult } from './backup-import';
import {
  createEmptyEdgeOneState,
  EDGEONE_SCHEMA_VERSION,
  EDGEONE_SCHEMA_VERSION_KEY,
  EDGEONE_STATE_KEY,
  normalizeEdgeOneState,
  type EdgeOneState,
} from './storage-edgeone-blob';
import { normalizeCustomEquivalentDomains, normalizeEquivalentDomains } from './domain-rules';
import type { Attachment, Cipher, Folder, User, UserDomainSettings } from '../types';

type BackupRow = BackupPayload['db']['users'][number];

export interface EdgeOneStateSummary {
  users: number;
  folders: number;
  ciphers: number;
  attachments: number;
  domainSettings: number;
  revisions: number;
}

export interface EdgeOneRestoreStore {
  get(key: string, options: { type: 'json'; consistency: 'strong' }): Promise<unknown | null>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
}

export interface ReplaceEdgeOneStateOptions {
  store: EdgeOneRestoreStore;
  stateKey: string;
  currentRaw: unknown;
  restoredState: EdgeOneState;
  expectedCurrentHash: string;
  rollbackKey: string;
}

export interface EdgeOneBackupImportExecutionResult extends BackupImportExecutionResult {
  rollbackKey: string;
}

function requiredString(row: BackupRow, key: string, table: string): string {
  const value = String(row[key] ?? '').trim();
  if (!value) throw new Error(`Backup ${table} row is missing ${key}`);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapUser(row: BackupRow): User {
  return {
    id: requiredString(row, 'id', 'users'),
    email: requiredString(row, 'email', 'users').toLowerCase(),
    name: nullableString(row.name),
    masterPasswordHint: nullableString(row.master_password_hint),
    masterPasswordHash: requiredString(row, 'master_password_hash', 'users'),
    key: requiredString(row, 'key', 'users'),
    privateKey: nullableString(row.private_key),
    publicKey: nullableString(row.public_key),
    kdfType: Number(row.kdf_type) || 0,
    kdfIterations: Number(row.kdf_iterations) || 0,
    kdfMemory: optionalNumber(row.kdf_memory),
    kdfParallelism: optionalNumber(row.kdf_parallelism),
    securityStamp: requiredString(row, 'security_stamp', 'users'),
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'banned' ? 'banned' : 'active',
    verifyDevices: row.verify_devices == null ? true : Number(row.verify_devices) !== 0,
    totpSecret: nullableString(row.totp_secret),
    totpRecoveryCode: nullableString(row.totp_recovery_code),
    apiKey: null,
    createdAt: requiredString(row, 'created_at', 'users'),
    updatedAt: requiredString(row, 'updated_at', 'users'),
  };
}

function mapFolder(row: BackupRow): Folder {
  return {
    id: requiredString(row, 'id', 'folders'),
    userId: requiredString(row, 'user_id', 'folders'),
    name: requiredString(row, 'name', 'folders'),
    createdAt: requiredString(row, 'created_at', 'folders'),
    updatedAt: requiredString(row, 'updated_at', 'folders'),
  };
}

function mapCipher(row: BackupRow): Cipher {
  const id = requiredString(row, 'id', 'ciphers');
  let parsed: Cipher;
  try {
    parsed = JSON.parse(requiredString(row, 'data', 'ciphers')) as Cipher;
  } catch {
    throw new Error(`Backup cipher row contains invalid data JSON: ${id}`);
  }

  const rawFolderId = row.folder_id ?? parsed.folderId ?? null;
  const folderId = rawFolderId == null || String(rawFolderId).trim() === '' ? null : String(rawFolderId).trim();
  return {
    ...parsed,
    id,
    userId: requiredString(row, 'user_id', 'ciphers'),
    type: Number(row.type) || Number(parsed.type) || 1,
    folderId,
    name: row.name == null ? parsed.name ?? null : String(row.name),
    notes: row.notes == null ? parsed.notes ?? null : String(row.notes),
    favorite: row.favorite == null ? !!parsed.favorite : Number(row.favorite) !== 0,
    reprompt: row.reprompt == null ? parsed.reprompt ?? 0 : Number(row.reprompt) || 0,
    key: row.key == null ? parsed.key ?? null : String(row.key),
    createdAt: requiredString(row, 'created_at', 'ciphers'),
    updatedAt: requiredString(row, 'updated_at', 'ciphers'),
    archivedAt: row.archived_at == null
      ? parsed.archivedAt ?? (parsed as { archivedDate?: string | null }).archivedDate ?? null
      : String(row.archived_at),
    deletedAt: nullableString(row.deleted_at),
  } as Cipher;
}

function mapAttachment(row: BackupRow): Attachment {
  return {
    id: requiredString(row, 'id', 'attachments'),
    cipherId: requiredString(row, 'cipher_id', 'attachments'),
    fileName: requiredString(row, 'file_name', 'attachments'),
    size: Number(row.size) || 0,
    sizeName: String(row.size_name || ''),
    key: nullableString(row.key),
  };
}

function mapDomainSettings(row: BackupRow): UserDomainSettings {
  const equivalentDomains = normalizeEquivalentDomains(parseJsonArray<string[]>(row.equivalent_domains));
  const storedCustom = normalizeCustomEquivalentDomains(parseJsonArray<unknown>(row.custom_equivalent_domains));
  return {
    userId: requiredString(row, 'user_id', 'domain_settings'),
    equivalentDomains,
    customEquivalentDomains: storedCustom.length ? storedCustom : normalizeCustomEquivalentDomains(equivalentDomains),
    excludedGlobalEquivalentDomains: parseJsonArray<number>(row.excluded_global_equivalent_domains),
    updatedAt: nullableString(row.updated_at),
  };
}

export function buildEdgeOneStateFromBackup(payload: BackupPayload): EdgeOneState {
  const state = createEmptyEdgeOneState();

  for (const row of payload.db.config) {
    const key = requiredString(row, 'key', 'config');
    if (row.value != null) state.config[key] = String(row.value);
  }

  for (const row of payload.db.users) {
    const user = mapUser(row);
    state.users[user.id] = user;
  }
  for (const row of payload.db.domain_settings) {
    const settings = mapDomainSettings(row);
    state.domainSettings[settings.userId] = settings;
  }
  for (const row of payload.db.user_revisions) {
    state.revisions[requiredString(row, 'user_id', 'user_revisions')] = requiredString(row, 'revision_date', 'user_revisions');
  }
  for (const row of payload.db.folders) {
    const folder = mapFolder(row);
    state.folders[folder.id] = folder;
  }
  for (const row of payload.db.ciphers) {
    const cipher = mapCipher(row);
    state.ciphers[cipher.id] = cipher;
  }
  for (const row of payload.db.attachments) {
    const attachment = mapAttachment(row);
    state.attachments[attachment.id] = attachment;
  }

  state.config[EDGEONE_SCHEMA_VERSION_KEY] = EDGEONE_SCHEMA_VERSION;
  state.config.registered = Object.keys(state.users).length > 0 ? 'true' : 'false';
  return state;
}

export function summarizeEdgeOneState(state: EdgeOneState): EdgeOneStateSummary {
  return {
    users: Object.keys(state.users).length,
    folders: Object.keys(state.folders).length,
    ciphers: Object.keys(state.ciphers).length,
    attachments: Object.keys(state.attachments).length,
    domainSettings: Object.keys(state.domainSettings).length,
    revisions: Object.keys(state.revisions).length,
  };
}

export async function hashEdgeOneJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function replaceEdgeOneStateWithRollback(options: ReplaceEdgeOneStateOptions): Promise<{
  currentHash: string;
  restoredHash: string;
  verifiedRaw: unknown;
}> {
  const currentHash = await hashEdgeOneJson(options.currentRaw);
  if (!currentHash.startsWith(options.expectedCurrentHash.toLowerCase())) {
    throw new Error(
      `Current state changed or the wrong project was selected: expected ${options.expectedCurrentHash}, received ${currentHash}`
    );
  }

  const latestRaw = await options.store.get(options.stateKey, { type: 'json', consistency: 'strong' });
  if (latestRaw == null || await hashEdgeOneJson(latestRaw) !== currentHash) {
    throw new Error('Current state changed after it was inspected; retry the restore.');
  }

  await options.store.setJSON(options.rollbackKey, latestRaw, { onlyIfNew: true });
  const rollbackRaw = await options.store.get(options.rollbackKey, { type: 'json', consistency: 'strong' });
  if (await hashEdgeOneJson(rollbackRaw) !== currentHash) {
    throw new Error(`Remote rollback verification failed for ${options.rollbackKey}`);
  }

  const restoredHash = await hashEdgeOneJson(options.restoredState);
  await options.store.setJSON(options.stateKey, options.restoredState);
  const verifiedRaw = await options.store.get(options.stateKey, { type: 'json', consistency: 'strong' });
  const verifiedHash = await hashEdgeOneJson(verifiedRaw);
  if (verifiedHash !== restoredHash) {
    throw new Error(`Restore verification failed. Rollback remains available at ${options.rollbackKey}`);
  }

  return { currentHash, restoredHash, verifiedRaw };
}

export async function importEdgeOneBackupArchiveBytes(
  archiveBytes: Uint8Array,
  store: EdgeOneRestoreStore,
  actorUserId: string,
  replaceExisting: boolean
): Promise<EdgeOneBackupImportExecutionResult> {
  const parsed = parseBackupArchive(archiveBytes);
  validateBackupPayloadContents(parsed.payload, parsed.files);
  if (parsed.payload.db.attachments.length > 0) {
    throw new Error('EdgeOne native backup import does not support archives containing attachments');
  }

  const currentRaw = await store.get(EDGEONE_STATE_KEY, { type: 'json', consistency: 'strong' });
  if (currentRaw == null) {
    throw new Error('Current EdgeOne state is missing; refusing restore without a rollback source');
  }
  const currentState = normalizeEdgeOneState(currentRaw);
  const currentDataCount =
    Object.keys(currentState.folders).length
    + Object.keys(currentState.ciphers).length
    + Object.keys(currentState.attachments).length
    + Object.keys(currentState.sends).length;
  if (currentDataCount > 0 && !replaceExisting) {
    throw new Error('Backup import requires a fresh instance with no vault or send data');
  }

  const restoredState = buildEdgeOneStateFromBackup(parsed.payload);
  const currentHash = await hashEdgeOneJson(currentRaw);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackKey = `restore-rollbacks/state-nodewarden-${timestamp}-${currentHash.slice(0, 12)}.json`;
  await replaceEdgeOneStateWithRollback({
    store,
    stateKey: EDGEONE_STATE_KEY,
    currentRaw,
    restoredState,
    expectedCurrentHash: currentHash,
    rollbackKey,
  });

  return {
    rollbackKey,
    auditActorUserId: Object.prototype.hasOwnProperty.call(restoredState.users, actorUserId) ? actorUserId : null,
    result: {
      object: 'instance-backup-import',
      imported: {
        config: parsed.payload.db.config.length,
        users: parsed.payload.db.users.length,
        domainSettings: parsed.payload.db.domain_settings.length,
        userRevisions: parsed.payload.db.user_revisions.length,
        folders: parsed.payload.db.folders.length,
        ciphers: parsed.payload.db.ciphers.length,
        attachments: 0,
        attachmentFiles: 0,
      },
      skipped: {
        reason: null,
        attachments: 0,
        items: [],
      },
    },
  };
}
