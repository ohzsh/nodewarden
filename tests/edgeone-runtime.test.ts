import assert from 'node:assert/strict';
import test from 'node:test';
import { handleEdgeOnePagesRequest } from '../src/edgeone/handler';

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
