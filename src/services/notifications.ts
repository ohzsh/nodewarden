import type { Env } from '../types';

const SIGNALR_UPDATE_TYPE_SYNC_VAULT = 1;
const SIGNALR_UPDATE_TYPE_LOG_OUT = 3;
const SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS = 1100;

function runBackground(task: Promise<unknown>): void {
  task.catch((error) => {
    console.error('Notification background task failed:', error);
  });
}

function hasNotificationHub(env: Env): env is Env & { NOTIFICATIONS_HUB: DurableObjectNamespace } {
  return !!env.NOTIFICATIONS_HUB;
}

async function notifyUserUpdate(
  env: Env,
  userId: string,
  updateType: number,
  revisionDate: string,
  contextId: string | null,
  targetDeviceIdentifier: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  if (!hasNotificationHub(env)) return;

  try {
    const id = env.NOTIFICATIONS_HUB.idFromName(userId);
    const stub = env.NOTIFICATIONS_HUB.get(id);
    await stub.fetch('https://notifications/internal/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NodeWarden-UserId': userId,
      },
      body: JSON.stringify({
        revisionDate,
        contextId: contextId || null,
        updateType,
        targetDeviceIdentifier: targetDeviceIdentifier || null,
        payload,
      }),
    });
  } catch (error) {
    console.error('Failed to broadcast realtime notification:', error);
  }
}

export function notifyUserVaultSync(
  env: Env,
  userId: string,
  revisionDate: string,
  contextId?: string | null
): void {
  runBackground(notifyUserUpdate(env, userId, SIGNALR_UPDATE_TYPE_SYNC_VAULT, revisionDate, contextId ?? null, null, {
    UserId: userId,
    Date: revisionDate,
  }));
}

export function notifyUserLogout(
  env: Env,
  userId: string,
  targetDeviceIdentifier?: string | null
): void {
  const revisionDate = new Date().toISOString();
  runBackground(notifyUserUpdate(env, userId, SIGNALR_UPDATE_TYPE_LOG_OUT, revisionDate, null, targetDeviceIdentifier ?? null, {
    UserId: userId,
    Date: revisionDate,
  }));
}

export async function getOnlineUserDevices(env: Env, userId: string): Promise<string[]> {
  if (!hasNotificationHub(env)) return [];

  try {
    const id = env.NOTIFICATIONS_HUB.idFromName(userId);
    const stub = env.NOTIFICATIONS_HUB.get(id);
    const response = await stub.fetch('https://notifications/internal/online');
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as { deviceIdentifiers?: string[] } | null;
    return Array.isArray(body?.deviceIdentifiers)
      ? body.deviceIdentifiers.filter((value) => !!String(value || '').trim())
      : [];
  } catch {
    return [];
  }
}

export async function notifyUserBackupProgress(
  env: Env,
  userId: string,
  progress: {
    operation: 'backup-restore' | 'backup-export' | 'backup-remote-run';
    source?: 'local' | 'remote';
    step: string;
    fileName: string;
    stageTitle?: string;
    stageDetail?: string;
    replaceExisting?: boolean;
    done?: boolean;
    ok?: boolean;
    error?: string | null;
    timestamp?: string;
  },
  targetDeviceIdentifier?: string | null
): Promise<void> {
  const revisionDate = progress.timestamp || new Date().toISOString();
  return notifyUserUpdate(env, userId, SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS, revisionDate, null, targetDeviceIdentifier || null, {
    UserId: userId,
    Date: revisionDate,
    ...progress,
  });
}

export function notifyUserBackupRestoreProgress(
  env: Env,
  userId: string,
  progress: Parameters<typeof notifyUserBackupProgress>[2],
  targetDeviceIdentifier?: string | null
): Promise<void> {
  return notifyUserBackupProgress(env, userId, progress, targetDeviceIdentifier);
}
