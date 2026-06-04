import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCiphersImport } from '../src/handlers/import';
import { StorageService } from '../src/services/storage';
import { createEdgeOneStorageBinding, type EdgeOneBlobStore } from '../src/services/storage-edgeone-blob';
import type { Env } from '../src/types';

function createMemoryEdgeOneBlobStore() {
  const entries = new Map<string, unknown>();
  let writeCount = 0;
  const store: EdgeOneBlobStore & { writeCount(): number } = {
    async set(key, value) {
      writeCount += 1;
      entries.set(key, value);
    },
    async setJSON(key, value) {
      writeCount += 1;
      entries.set(key, JSON.stringify(value));
    },
    async get(key, options) {
      const value = entries.get(key);
      if (value == null) return null;
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer);
      if (options?.type === 'text') return text as never;
      return JSON.parse(text) as never;
    },
    async delete(key) {
      entries.delete(key);
    },
    writeCount() {
      return writeCount;
    },
  };
  return store;
}

function envWithStore(store = createMemoryEdgeOneBlobStore()): { env: Env; store: ReturnType<typeof createMemoryEdgeOneBlobStore> } {
  return {
    env: {
      DB: createEdgeOneStorageBinding(store) as unknown as D1Database,
      JWT_SECRET: 'nodewarden-import-test-secret-placeholder-value',
    },
    store,
  };
}

function importRequest(payload: unknown): Request {
  return new Request('https://nodewarden.example.invalid/api/ciphers/import?returnCipherMap=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('cipher import is idempotent for repeated Bitwarden source ids', async () => {
  const { env } = envWithStore();
  const userId = 'user-1';
  const payload = {
    folders: [{ id: 'folder-source-id', name: '2.folder|cipher|mac' }],
    ciphers: [
      {
        id: '6e9892f2-29ef-4440-bd7d-fb5563e2afc3',
        type: 1,
        name: '2.name1|cipher|mac',
        login: { uris: [], username: '2.user1|cipher|mac', password: '2.pass1|cipher|mac' },
      },
      {
        id: 'f8d17b80-cb5b-4302-9da2-36dded741e37',
        type: 1,
        name: '2.name2|cipher|mac',
        login: {
          uris: [{ uri: '2.uri|cipher|mac', uriChecksum: '2.sum|cipher|mac', match: null }],
          username: '2.user2|cipher|mac',
          password: '2.pass2|cipher|mac',
        },
      },
    ],
    folderRelationships: [{ key: 0, value: 0 }],
  };

  const first = await handleCiphersImport(importRequest(payload), env, userId);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { cipherMap: Array<{ id: string; sourceId: string | null }> };
  assert.equal(firstBody.cipherMap.length, 2);

  const second = await handleCiphersImport(importRequest(payload), env, userId);
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { cipherMap: Array<{ id: string; sourceId: string | null }> };
  assert.deepEqual(
    secondBody.cipherMap.map((row) => row.id),
    firstBody.cipherMap.map((row) => row.id)
  );

  const storage = new StorageService(env.DB);
  const ciphers = await storage.getAllCiphers(userId);
  const folders = await storage.getAllFolders(userId);
  assert.equal(ciphers.length, 2);
  assert.equal(folders.length, 1);
});

test('EdgeOne import persists the whole batch with one state write', async () => {
  const { env, store } = envWithStore();
  const response = await handleCiphersImport(importRequest({
    folders: [{ id: 'folder-source-id', name: '2.folder|cipher|mac' }],
    ciphers: [
      { id: 'source-1', type: 1, name: '2.name1|cipher|mac', login: null },
      { id: 'source-2', type: 1, name: '2.name2|cipher|mac', login: null },
    ],
    folderRelationships: [],
  }), env, 'user-1');

  assert.equal(response.status, 200);
  assert.equal(store.writeCount(), 1);
});
