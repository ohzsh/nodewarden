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

const DEFAULT_DATA_STORE = 'nodewarden-data';
const DEFAULT_ATTACHMENT_STORE = 'nodewarden-attachments';

const UNSUPPORTED_EDGEONE_PATHS = new Set([
  '/notifications/hub',
  '/api/admin/backup/import',
  '/api/admin/backup/remote/restore',
]);

function readRuntimeValue(context: EdgeOnePagesContext, key: string): string | undefined {
  const fromContext = context.env?.[key];
  if (typeof fromContext === 'string') return fromContext;
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return processEnv?.[key];
}

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;
  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function createEdgeOneEnv(context: EdgeOnePagesContext): Env {
  const dataStoreName = readRuntimeValue(context, 'NODEWARDEN_EDGEONE_DATA_STORE') || DEFAULT_DATA_STORE;
  const attachmentStoreName = readRuntimeValue(context, 'NODEWARDEN_EDGEONE_ATTACHMENT_STORE') || DEFAULT_ATTACHMENT_STORE;
  const dataStore = getStore({ name: dataStoreName, consistency: 'strong' }) as EdgeOneBlobStore;
  const attachmentStore = getStore({ name: attachmentStoreName, consistency: 'strong' }) as EdgeOneBlobStore;

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
  const request = normalizeRequestUrl(context.request);
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
