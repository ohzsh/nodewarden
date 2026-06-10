import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteBackupRunCompleteProgress } from '../webapp/src/lib/backup-restore-progress';

test('remote backup run completion creates a terminal progress event from the HTTP result', () => {
  const event = createRemoteBackupRunCompleteProgress({
    object: 'backup-run',
    result: {
      fileName: 'nodewarden_backup_20260610_090721_f1fc9.zip',
      fileSize: 429210,
      provider: 'webdav',
      remotePath: 'nodewarden_backup_20260610_090721_f1fc9.zip',
    },
    settings: { destinations: [] },
  });

  assert.deepEqual(event, {
    operation: 'backup-remote-run',
    source: 'remote',
    step: 'remote_run_complete',
    fileName: 'nodewarden_backup_20260610_090721_f1fc9.zip',
    stageTitle: 'txt_backup_remote_run_progress_complete_title',
    stageDetail: 'txt_backup_remote_run_progress_complete_detail',
    done: true,
    ok: true,
  });
});
