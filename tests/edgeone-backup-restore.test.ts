import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { BackupPayload } from '../src/services/backup-archive';
import {
  buildEdgeOneStateFromBackup,
  hashEdgeOneJson,
  importEdgeOneBackupArchiveBytes,
  replaceEdgeOneStateWithRollback,
  summarizeEdgeOneState,
  type EdgeOneRestoreStore,
} from '../src/services/edgeone-backup-restore';
import {
  createEmptyEdgeOneState,
  EDGEONE_SCHEMA_VERSION,
  EDGEONE_SCHEMA_VERSION_KEY,
  EDGEONE_STATE_KEY,
} from '../src/services/storage-edgeone-blob';

function backupPayload(cipherData: string = JSON.stringify({ login: { username: '2.encrypted' }, fields: null })): BackupPayload {
  return {
    manifest: {
      formatVersion: 1,
      exportedAt: '2026-06-30T02:59:03.394Z',
      appVersion: '1.5.2',
      storageKind: 'edgeone-blob',
      tableCounts: {},
      includes: { attachments: false },
      blobSummary: { attachmentFiles: 0, totalBytes: 0, largestObjectBytes: 0 },
      attachmentBlobs: [],
    },
    db: {
      config: [{ key: 'registered', value: 'true' }, { key: 'schema.version', value: 'old' }],
      users: [{
        id: 'user-1', email: 'USER@example.invalid', name: 'User', master_password_hint: null,
        master_password_hash: 'hash', key: '2.user-key', private_key: null, public_key: 'public-key',
        kdf_type: 0, kdf_iterations: 600000, kdf_memory: null, kdf_parallelism: null,
        security_stamp: 'stamp', role: 'admin', status: 'active', verify_devices: 1,
        totp_secret: null, totp_recovery_code: null, created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }],
      domain_settings: [{
        user_id: 'user-1', equivalent_domains: '[["example.com","example.org"]]',
        custom_equivalent_domains: '[]', excluded_global_equivalent_domains: '[1]',
        updated_at: '2026-01-02T00:00:00.000Z',
      }],
      user_revisions: [{ user_id: 'user-1', revision_date: '2026-01-03T00:00:00.000Z' }],
      folders: [{ id: 'folder-1', user_id: 'user-1', name: '2.folder', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' }],
      ciphers: [{
        id: 'cipher-1', user_id: 'user-1', type: 1, folder_id: 'folder-1', name: '2.name', notes: null,
        favorite: 1, data: cipherData, reprompt: 0, key: null, created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z', archived_at: null, deleted_at: null,
      }],
      attachments: [],
    },
  };
}

function backupArchiveBytes(
  payload: BackupPayload,
  extraFiles: Record<string, Uint8Array> = {}
): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(payload.manifest)),
    'db.json': strToU8(JSON.stringify(payload.db)),
    ...extraFiles,
  });
}

test('buildEdgeOneStateFromBackup restores persistent rows and resets runtime state', () => {
  const state = buildEdgeOneStateFromBackup(backupPayload());

  assert.equal(state.config[EDGEONE_SCHEMA_VERSION_KEY], EDGEONE_SCHEMA_VERSION);
  assert.equal(state.config.registered, 'true');
  assert.equal(state.users['user-1'].email, 'user@example.invalid');
  assert.equal(state.users['user-1'].apiKey, null);
  assert.equal(state.folders['folder-1'].userId, 'user-1');
  assert.equal(state.ciphers['cipher-1'].folderId, 'folder-1');
  assert.equal(state.ciphers['cipher-1'].favorite, true);
  assert.deepEqual(state.domainSettings['user-1'].excludedGlobalEquivalentDomains, [1]);
  assert.equal(state.revisions['user-1'], '2026-01-03T00:00:00.000Z');
  assert.deepEqual(state.refreshTokens, {});
  assert.deepEqual(state.devices, {});
  assert.deepEqual(state.auditLogs, {});
  assert.deepEqual(summarizeEdgeOneState(state), {
    users: 1,
    folders: 1,
    ciphers: 1,
    attachments: 0,
    domainSettings: 1,
    revisions: 1,
  });
});

test('buildEdgeOneStateFromBackup rejects invalid cipher JSON', () => {
  assert.throws(
    () => buildEdgeOneStateFromBackup(backupPayload('{invalid')),
    /Backup cipher row contains invalid data JSON: cipher-1/
  );
});

function memoryStore(initial: Record<string, unknown>): EdgeOneRestoreStore & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async setJSON(key, value, options) {
      if (options?.onlyIfNew && values.has(key)) throw new Error('already exists');
      values.set(key, structuredClone(value));
    },
  };
}

test('replaceEdgeOneStateWithRollback preserves current state and verifies replacement', async () => {
  const current = buildEdgeOneStateFromBackup(backupPayload());
  const restored = buildEdgeOneStateFromBackup(backupPayload());
  restored.ciphers['cipher-2'] = { ...restored.ciphers['cipher-1'], id: 'cipher-2' };
  const store = memoryStore({ [EDGEONE_STATE_KEY]: current });
  const currentHash = await hashEdgeOneJson(current);

  const result = await replaceEdgeOneStateWithRollback({
    store,
    stateKey: EDGEONE_STATE_KEY,
    currentRaw: current,
    restoredState: restored,
    expectedCurrentHash: currentHash.slice(0, 12),
    rollbackKey: 'restore-rollbacks/test.json',
  });

  assert.deepEqual(store.values.get('restore-rollbacks/test.json'), current);
  assert.deepEqual(store.values.get(EDGEONE_STATE_KEY), restored);
  assert.equal(result.currentHash, currentHash);
  assert.equal(result.restoredHash, await hashEdgeOneJson(restored));
});

test('replaceEdgeOneStateWithRollback refuses a stale current-state hash', async () => {
  const current = buildEdgeOneStateFromBackup(backupPayload());
  const store = memoryStore({ [EDGEONE_STATE_KEY]: current });

  await assert.rejects(
    replaceEdgeOneStateWithRollback({
      store,
      stateKey: EDGEONE_STATE_KEY,
      currentRaw: current,
      restoredState: current,
      expectedCurrentHash: 'deadbeef',
      rollbackKey: 'restore-rollbacks/test.json',
    }),
    /Current state changed or the wrong project was selected/
  );
  assert.equal(store.values.has('restore-rollbacks/test.json'), false);
});

test('importEdgeOneBackupArchiveBytes replaces a fresh account and preserves a remote rollback', async () => {
  const payload = backupPayload();
  const expected = buildEdgeOneStateFromBackup(payload);
  const current = createEmptyEdgeOneState();
  current.config.registered = 'true';
  current.users['new-user'] = {
    ...expected.users['user-1'],
    id: 'new-user',
    email: 'new-user@example.invalid',
  };
  const store = memoryStore({ [EDGEONE_STATE_KEY]: current });

  const imported = await importEdgeOneBackupArchiveBytes(
    backupArchiveBytes(payload),
    store,
    'new-user',
    false
  );

  assert.match(imported.rollbackKey, /^restore-rollbacks\/state-nodewarden-.+\.json$/);
  assert.deepEqual(store.values.get(imported.rollbackKey), current);
  assert.deepEqual(store.values.get(EDGEONE_STATE_KEY), expected);
  assert.equal(imported.auditActorUserId, null);
  assert.deepEqual(imported.result.imported, {
    config: 2,
    users: 1,
    domainSettings: 1,
    userRevisions: 1,
    folders: 1,
    ciphers: 1,
    attachments: 0,
    attachmentFiles: 0,
  });
});

test('importEdgeOneBackupArchiveBytes requires replacement approval for existing vault data', async () => {
  const payload = backupPayload();
  const current = buildEdgeOneStateFromBackup(payload);
  const store = memoryStore({ [EDGEONE_STATE_KEY]: current });

  await assert.rejects(
    importEdgeOneBackupArchiveBytes(backupArchiveBytes(payload), store, 'user-1', false),
    /fresh instance with no vault or send data/
  );
  assert.deepEqual(store.values.get(EDGEONE_STATE_KEY), current);
  assert.equal(Array.from(store.values.keys()).some((key) => key.startsWith('restore-rollbacks/')), false);
});

test('importEdgeOneBackupArchiveBytes rejects attachment archives before writing state', async () => {
  const payload = backupPayload();
  payload.manifest.includes.attachments = true;
  payload.db.attachments.push({
    id: 'attachment-1',
    cipher_id: 'cipher-1',
    file_name: '2.file',
    size: 4,
    size_name: '4 B',
    key: '2.key',
  });
  const current = createEmptyEdgeOneState();
  const store = memoryStore({ [EDGEONE_STATE_KEY]: current });

  await assert.rejects(
    importEdgeOneBackupArchiveBytes(
      backupArchiveBytes(payload, {
        'attachments/cipher-1/attachment-1.bin': strToU8('test'),
      }),
      store,
      'new-user',
      true
    ),
    /does not support archives containing attachments/
  );
  assert.deepEqual(Array.from(store.values.entries()), [[EDGEONE_STATE_KEY, current]]);
});
