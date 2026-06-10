import assert from 'node:assert/strict';
import test from 'node:test';
import { isRealtimeNotificationsUnsupportedStatus } from '../webapp/src/lib/realtime-notifications';

test('realtime notification probe treats platform unsupported statuses as terminal', () => {
  assert.equal(isRealtimeNotificationsUnsupportedStatus(404), true);
  assert.equal(isRealtimeNotificationsUnsupportedStatus(426), true);
  assert.equal(isRealtimeNotificationsUnsupportedStatus(501), true);
});

test('realtime notification probe keeps retryable statuses retryable', () => {
  assert.equal(isRealtimeNotificationsUnsupportedStatus(0), false);
  assert.equal(isRealtimeNotificationsUnsupportedStatus(401), false);
  assert.equal(isRealtimeNotificationsUnsupportedStatus(429), false);
  assert.equal(isRealtimeNotificationsUnsupportedStatus(500), false);
});
