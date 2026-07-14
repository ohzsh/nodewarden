import assert from 'node:assert/strict';
import test from 'node:test';
import { createEdgeOneStoreOptions, handleEdgeOnePagesRequest } from '../src/edgeone/handler';
import { handleSync } from '../src/handlers/sync';
import { StorageService } from '../src/services/storage';
import { createEdgeOneStorageBinding, type EdgeOneBlobStore } from '../src/services/storage-edgeone-blob';
import type { Env, User } from '../src/types';

const PUBLIC_ORIGIN = 'https://nodewarden.example.edgeone.run';
const PUBLIC_HOST = 'nodewarden.example.edgeone.run';
const STRONG_TEST_SECRET = 'nodewarden-edgeone-test-secret-123456';

function edgeOneContext(request: Request) {
  return {
    request,
    env: {
      NODEWARDEN_EDGEONE_LOCAL_BLOB: '1',
      JWT_SECRET: STRONG_TEST_SECRET,
    },
  };
}

function edgeOneContextWithEnv(request: Request, env: Record<string, string>) {
  return {
    request,
    env: {
      NODEWARDEN_EDGEONE_LOCAL_BLOB: '1',
      JWT_SECRET: STRONG_TEST_SECRET,
      ...env,
    },
  };
}

function edgeOneRequestWithArrayBufferBody(url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}): Request {
  const bytes = new TextEncoder().encode(init.body);
  return {
    url,
    method: init.method,
    headers: new Headers(init.headers),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  } as unknown as Request;
}

function createMemoryEdgeOneBlobStore(): EdgeOneBlobStore {
  const entries = new Map<string, unknown>();
  return {
    async set(key, value) {
      entries.set(key, value);
    },
    async setJSON(key, value) {
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
  };
}

function testUser(overrides: Partial<User> = {}): User {
  const now = '2026-06-04T00:00:00.000Z';
  return {
    id: 'edgeone-sync-user',
    email: 'edgeone-sync@example.invalid',
    name: 'EdgeOne Sync',
    masterPasswordHint: null,
    masterPasswordHash: 'hash',
    key: 'encrypted-user-key',
    privateKey: null,
    publicKey: null,
    kdfType: 0,
    kdfIterations: 600000,
    securityStamp: 'security-stamp',
    role: 'user',
    status: 'active',
    verifyDevices: true,
    totpSecret: null,
    totpRecoveryCode: null,
    apiKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('EdgeOne runtime uses the public host for same-origin write checks', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContext(new Request('http://localhost:9000/api/accounts/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: PUBLIC_HOST,
      Origin: PUBLIC_ORIGIN,
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
    body: '{}',
  })));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.notEqual(body.error, 'Forbidden origin');
  assert.match(String(body.error), /Email, masterPasswordHash, and key are required/);
});

test('EdgeOne runtime reports public service URLs in config responses', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContext(new Request('http://localhost:9000/config', {
    headers: {
      Host: PUBLIC_HOST,
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
  })));
  const body = await response.json() as { environment?: { vault?: string; api?: string; identity?: string } };

  assert.equal(response.status, 200);
  assert.equal(body.environment?.vault, PUBLIC_ORIGIN);
  assert.equal(body.environment?.api, `${PUBLIC_ORIGIN}/api`);
  assert.equal(body.environment?.identity, `${PUBLIC_ORIGIN}/identity`);
});

test('EdgeOne runtime does not trust Origin as the public host', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContext(new Request('http://localhost:9000/api/accounts/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: PUBLIC_ORIGIN,
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
    body: '{}',
  })));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 403);
  assert.equal(body.error, 'Forbidden origin');
});

test('EdgeOne runtime can use configured public origin when proxy host is internal', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContextWithEnv(new Request('http://internal.edgeone-function.local/api/accounts/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'internal.edgeone-function.local',
      Origin: PUBLIC_ORIGIN,
      Referer: `${PUBLIC_ORIGIN}/register`,
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
    body: '{}',
  }), {
    NODEWARDEN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  }));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.notEqual(body.error, 'Forbidden origin');
  assert.match(String(body.error), /Email, masterPasswordHash, and key are required/);
});

test('EdgeOne runtime preserves POST body when normalizing configured public origin', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContextWithEnv(edgeOneRequestWithArrayBufferBody(
    'http://internal.edgeone-function.local/api/accounts/register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'internal.edgeone-function.local',
        Origin: PUBLIC_ORIGIN,
        Referer: `${PUBLIC_ORIGIN}/register`,
        'X-Forwarded-For': '203.0.113.10',
        'X-Forwarded-Proto': 'https',
      },
      body: '{}',
    }
  ), {
    NODEWARDEN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  }));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 400);
  assert.notEqual(body.error, 'Invalid JSON');
  assert.match(String(body.error), /Email, masterPasswordHash, and key are required/);
});

test('EdgeOne runtime uses configured public origin in config responses', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContextWithEnv(new Request('http://internal.edgeone-function.local/config', {
    headers: {
      Host: 'internal.edgeone-function.local',
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
  }), {
    NODEWARDEN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  }));
  const body = await response.json() as { environment?: { vault?: string; api?: string; identity?: string } };

  assert.equal(response.status, 200);
  assert.equal(body.environment?.vault, PUBLIC_ORIGIN);
  assert.equal(body.environment?.api, `${PUBLIC_ORIGIN}/api`);
  assert.equal(body.environment?.identity, `${PUBLIC_ORIGIN}/identity`);
});

test('EdgeOne runtime routes local backup import through authentication', async () => {
  const response = await handleEdgeOnePagesRequest(edgeOneContext(new Request('http://localhost:9000/api/admin/backup/import', {
    method: 'POST',
    headers: {
      Host: PUBLIC_HOST,
      Origin: PUBLIC_ORIGIN,
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    },
  })));
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 401);
  assert.equal(body.error, 'Unauthorized');
});

test('EdgeOne runtime passes external Pages Blob credentials for online-data local debugging', () => {
  const options = createEdgeOneStoreOptions(edgeOneContextWithEnv(new Request('http://localhost/config'), {
    NODEWARDEN_EDGEONE_PROJECT_ID: 'pages-nodewarden',
    NODEWARDEN_EDGEONE_BLOB_TOKEN: 'edgeone-blob-token',
  }), 'nodewarden-data');

  assert.deepEqual(options, {
    name: 'nodewarden-data',
    consistency: 'strong',
    projectId: 'pages-nodewarden',
    token: 'edgeone-blob-token',
  });
});

test('EdgeOne sync does not require Cache API support', async (t) => {
  const globalWithCaches = globalThis as typeof globalThis & { caches?: unknown };
  const originalCaches = globalWithCaches.caches;
  Reflect.deleteProperty(globalWithCaches, 'caches');
  t.after(() => {
    if (originalCaches === undefined) Reflect.deleteProperty(globalWithCaches, 'caches');
    else globalWithCaches.caches = originalCaches;
  });

  const db = createEdgeOneStorageBinding(createMemoryEdgeOneBlobStore()) as unknown as D1Database;
  const env = { DB: db, JWT_SECRET: STRONG_TEST_SECRET } as Env;
  const storage = new StorageService(env.DB);
  const user = testUser();
  await storage.createFirstUser(user);

  const response = await handleSync(new Request('https://nodewarden.example.edgeone.run/api/sync'), env, user.id);
  const body = await response.json() as { object?: string; profile?: { id?: string } };

  assert.equal(response.status, 200);
  assert.equal(body.object, 'sync');
  assert.equal(body.profile?.id, user.id);
});
