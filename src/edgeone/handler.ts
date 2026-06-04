import { getStore } from '@edgeone/pages-blob';
import { handleRequest } from '../router';
import type { Env } from '../types';
import { runScheduledBackupIfDue } from '../handlers/backup';
import { StorageService } from '../services/storage';
import { createEdgeOneStorageBinding, type EdgeOneBlobStore } from '../services/storage-edgeone-blob';
import { applyCors, jsonResponse } from '../utils/response';

interface EdgeOnePagesContext {
  request: Request;
  env?: Record<string, unknown>;
  waitUntil?: (task: Promise<unknown>) => void;
}

type EdgeOneStoreOptions = {
  name: string;
  consistency: 'strong';
  projectId?: string;
  token?: string;
};

const DEFAULT_DATA_STORE = 'nodewarden-data';
const DEFAULT_ATTACHMENT_STORE = 'nodewarden-attachments';
const localBlobStores = new Map<string, EdgeOneBlobStore>();

const UNSUPPORTED_EDGEONE_PATHS = new Set([
  '/notifications/hub',
  '/api/admin/backup/import',
  '/api/admin/backup/remote/restore',
]);

function readRuntimeValue(context: { env?: Record<string, unknown> }, key: string): string | undefined {
  const fromContext = context.env?.[key];
  if (typeof fromContext === 'string') return fromContext;
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return processEnv?.[key];
}

async function normalizeLocalBlobValue(value: string | ArrayBuffer | Blob | ReadableStream): Promise<string | ArrayBuffer> {
  if (typeof value === 'string' || value instanceof ArrayBuffer) return value;
  return new Response(value).arrayBuffer();
}

function encodeLocalBlobText(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function getLocalBlobStore(name: string): EdgeOneBlobStore {
  const existing = localBlobStores.get(name);
  if (existing) return existing;

  const entries = new Map<string, { value: string | ArrayBuffer; headers: Record<string, string> }>();
  const store: EdgeOneBlobStore = {
    async set(key, value, options) {
      if (options?.onlyIfNew && entries.has(key)) return;
      entries.set(key, {
        value: await normalizeLocalBlobValue(value),
        headers: {},
      });
    },
    async setJSON(key, value, options) {
      if (options?.onlyIfNew && entries.has(key)) return;
      entries.set(key, {
        value: JSON.stringify(value),
        headers: { 'content-type': 'application/json' },
      });
    },
    async get<T = unknown>(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream' }): Promise<T | null> {
      const entry = entries.get(key);
      if (!entry) return null;
      const value = entry.value;
      const type = options?.type || 'json';
      if (type === 'json') return JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value)) as T;
      if (type === 'text') return (typeof value === 'string' ? value : new TextDecoder().decode(value)) as T;
      const buffer = typeof value === 'string' ? encodeLocalBlobText(value) : value;
      if (type === 'arrayBuffer') return buffer as T;
      if (type === 'blob') return new Blob([buffer]) as T;
      return new Response(buffer).body as T;
    },
    async getWithHeaders(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      return {
        body: typeof entry.value === 'string' ? entry.value : new TextDecoder().decode(entry.value),
        headers: entry.headers,
      };
    },
    async delete(key) {
      entries.delete(key);
    },
  };
  localBlobStores.set(name, store);
  return store;
}

function createEdgeOneBlobStore(context: EdgeOnePagesContext, name: string): EdgeOneBlobStore {
  if (readRuntimeValue(context, 'NODEWARDEN_EDGEONE_LOCAL_BLOB') === '1') {
    return getLocalBlobStore(name);
  }
  return getStore(createEdgeOneStoreOptions(context, name)) as EdgeOneBlobStore;
}

export function createEdgeOneStoreOptions(context: Pick<EdgeOnePagesContext, 'env'>, name: string): EdgeOneStoreOptions {
  const projectId = (
    readRuntimeValue(context, 'NODEWARDEN_EDGEONE_PROJECT_ID') ||
    readRuntimeValue(context, 'EDGEONE_PAGES_PROJECT_ID')
  )?.trim();
  const token = (
    readRuntimeValue(context, 'NODEWARDEN_EDGEONE_BLOB_TOKEN') ||
    readRuntimeValue(context, 'EDGEONE_PAGES_BLOB_TOKEN')
  )?.trim();

  if (projectId && token) {
    return { name, consistency: 'strong', projectId, token };
  }

  if (projectId || token) {
    throw new Error('Both NODEWARDEN_EDGEONE_PROJECT_ID and NODEWARDEN_EDGEONE_BLOB_TOKEN are required for external Pages Blob access.');
  }

  return { name, consistency: 'strong' };
}

function firstHeaderValue(value: string | null): string | null {
  const normalized = value?.split(',')[0]?.trim();
  return normalized || null;
}

function unquoteForwardedValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function normalizePublicHost(value: string | null): string | null {
  const host = unquoteForwardedValue(firstHeaderValue(value) || '');
  if (!host || host.includes('/') || host.includes('\\') || host.includes('@')) return null;
  try {
    return new URL(`https://${host}`).host || null;
  } catch {
    return null;
  }
}

function readPublicHost(headers: Headers): string | null {
  return (
    normalizePublicHost(headers.get('X-Forwarded-Host')) ||
    normalizePublicHost(headers.get('Host'))
  );
}

function normalizePublicProtocol(value: string | null): 'http:' | 'https:' | null {
  const protocol = unquoteForwardedValue(firstHeaderValue(value) || '').replace(/:$/, '').toLowerCase();
  if (protocol === 'http' || protocol === 'https') return `${protocol}:`;
  if (protocol === 'quic') return 'https:';
  return null;
}

function readPublicProtocol(request: Request, fallback: string): 'http:' | 'https:' {
  return (
    normalizePublicProtocol(request.headers.get('X-Forwarded-Proto')) ||
    (fallback === 'https:' ? 'https:' : 'http:')
  );
}

function normalizePublicOrigin(value: string | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const origin = new URL(raw);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
    if (origin.username || origin.password) return null;
    return new URL(origin.origin);
  } catch {
    return null;
  }
}

function readConfiguredPublicOrigin(context: EdgeOnePagesContext): URL | null {
  return normalizePublicOrigin(readRuntimeValue(context, 'NODEWARDEN_PUBLIC_ORIGIN'));
}

function applyPublicOrigin(url: URL, publicHost: string, publicProtocol: 'http:' | 'https:'): void {
  const origin = new URL(`${publicProtocol}//${publicHost}`);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;
}

function normalizeRequestUrl(context: EdgeOnePagesContext): Request {
  const request = context.request;
  const url = new URL(request.url);
  const configuredOrigin = readConfiguredPublicOrigin(context);
  if (configuredOrigin) {
    applyPublicOrigin(url, configuredOrigin.host, configuredOrigin.protocol as 'http:' | 'https:');
  } else {
    const publicHost = readPublicHost(request.headers);
    if (publicHost) {
      applyPublicOrigin(url, publicHost, readPublicProtocol(request, url.protocol));
    }
  }
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname && url.toString() === request.url) return request;
  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function createEdgeOneEnv(context: EdgeOnePagesContext): Env {
  const dataStoreName = readRuntimeValue(context, 'NODEWARDEN_EDGEONE_DATA_STORE') || DEFAULT_DATA_STORE;
  const attachmentStoreName = readRuntimeValue(context, 'NODEWARDEN_EDGEONE_ATTACHMENT_STORE') || DEFAULT_ATTACHMENT_STORE;
  const dataStore = createEdgeOneBlobStore(context, dataStoreName);
  const attachmentStore = createEdgeOneBlobStore(context, attachmentStoreName);

  return {
    ...(context.env as Record<string, unknown>),
    DB: createEdgeOneStorageBinding(dataStore, attachmentStore) as unknown as D1Database,
    EDGEONE_ATTACHMENTS: attachmentStore,
    EDGEONE_RUNTIME: 'pages',
    JWT_SECRET: readRuntimeValue(context, 'JWT_SECRET') || '',
  } as Env;
}

function isUnsupportedEdgeOneRoute(path: string): boolean {
  if (UNSUPPORTED_EDGEONE_PATHS.has(path)) return true;
  return path.startsWith('/notifications/');
}

async function ensureEdgeOneStorageInitialized(env: Env): Promise<void> {
  const storage = new StorageService(env.DB);
  await storage.initializeDatabase();
}

export async function handleEdgeOnePagesRequest(context: EdgeOnePagesContext): Promise<Response> {
  const request = normalizeRequestUrl(context);
  const env = createEdgeOneEnv(context);
  await ensureEdgeOneStorageInitialized(env);

  const path = new URL(request.url).pathname;
  if (path === '/api/cron/backup') {
    const task = runScheduledBackupIfDue(env).catch((error) => {
      console.error('EdgeOne scheduled backup failed:', error);
    });
    context.waitUntil?.(task);
    if (!context.waitUntil) await task;
    return jsonResponse({ ok: true, runtime: 'edgeone-pages' });
  }

  if (isUnsupportedEdgeOneRoute(path)) {
    return jsonResponse(
      {
        error: 'Unsupported on EdgeOne Pages',
        error_description: 'This route requires Cloudflare Durable Objects or D1 shadow-table restore support.',
      },
      501
    );
  }

  const response = await handleRequest(request, env);
  return applyCors(request, response);
}
