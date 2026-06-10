export type BackupProgressOperation = 'backup-restore' | 'backup-export' | 'backup-remote-run';

export interface BackupProgressDetail {
  operation: BackupProgressOperation;
  source?: 'local' | 'remote';
  step: string;
  fileName: string;
  stageTitle?: string;
  stageDetail?: string;
  replaceExisting?: boolean;
  done?: boolean;
  ok?: boolean;
  error?: string | null;
  Date?: string;
}

export type BackupRestoreProgressDetail = BackupProgressDetail;

interface RemoteBackupRunCompletionSource {
  result?: {
    fileName?: string;
  } | null;
}

export const BACKUP_PROGRESS_EVENT = 'nodewarden:backup-progress';
export const BACKUP_RESTORE_PROGRESS_EVENT = BACKUP_PROGRESS_EVENT;

export function createRemoteBackupRunCompleteProgress(result: RemoteBackupRunCompletionSource): BackupProgressDetail {
  return {
    operation: 'backup-remote-run',
    source: 'remote',
    step: 'remote_run_complete',
    fileName: String(result.result?.fileName || ''),
    stageTitle: 'txt_backup_remote_run_progress_complete_title',
    stageDetail: 'txt_backup_remote_run_progress_complete_detail',
    done: true,
    ok: true,
  };
}

export function dispatchBackupProgress(detail: BackupProgressDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BackupProgressDetail>(BACKUP_PROGRESS_EVENT, { detail }));
}

export const dispatchBackupRestoreProgress = dispatchBackupProgress;
