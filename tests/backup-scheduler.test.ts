import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBackupSchedulerScanStart,
  hasBackupSlotBetween,
  type BackupDestinationRecord,
} from '../src/services/backup-config';

function scheduledDestination(overrides: Partial<BackupDestinationRecord> = {}): BackupDestinationRecord {
  return {
    id: 'backup-destination-1',
    name: 'WebDAV 1',
    type: 'webdav',
    includeAttachments: false,
    destination: {
      baseUrl: 'https://dav.example.invalid',
      username: 'user',
      password: 'pass',
      remotePath: 'nodewarden',
    },
    schedule: {
      enabled: true,
      intervalHours: 24,
      startTime: '03:00',
      timezone: 'UTC',
      retentionCount: 30,
    },
    runtime: {
      lastAttemptAt: null,
      lastAttemptLocalDate: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastUploadedFileName: null,
      lastUploadedSizeBytes: null,
      lastUploadedDestination: null,
    },
    ...overrides,
  };
}

test('scheduler scan start lets a low-frequency cron catch a missed backup slot', () => {
  const now = new Date('2026-06-10T03:15:00.000Z');
  const scanStart = getBackupSchedulerScanStart('2026-06-10T02:45:00.000Z', now);

  assert.equal(
    hasBackupSlotBetween(scheduledDestination(), scanStart, now),
    true
  );
});

test('scheduler scan start falls back to max lookback for invalid state', () => {
  const now = new Date('2026-06-10T03:15:00.000Z');
  const scanStart = getBackupSchedulerScanStart('not-a-date', now);

  assert.equal(scanStart.toISOString(), '2026-06-09T03:15:00.000Z');
});
