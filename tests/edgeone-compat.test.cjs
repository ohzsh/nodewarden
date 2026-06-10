const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('EdgeOne build metadata is declared for Pages deployment', () => {
  const pkg = readJson('package.json');
  const config = readJson('edgeone.json');

  assert.equal(pkg.scripts['build:edgeone:functions'], 'node scripts/build-edgeone-functions.cjs');
  assert.equal(pkg.scripts['build:edgeone'], 'npm run build && node scripts/pages-spa-redirects.cjs && npm run build:edgeone:functions');
  assert.equal(
    pkg.scripts['dev:edgeone'],
    'NODEWARDEN_EDGEONE_LOCAL_BLOB=1 JWT_SECRET=nodewarden-local-edgeone-dev npm run build:edgeone:functions && NODEWARDEN_EDGEONE_LOCAL_BLOB=1 JWT_SECRET=nodewarden-local-edgeone-dev edgeone pages dev --skip-env-sync'
  );
  assert.equal(pkg.scripts['dev:edgeone:online'], 'npm run build:edgeone:functions && edgeone pages dev');
  assert.equal(pkg.scripts['deploy:edgeone'], 'edgeone pages deploy');

  assert.equal(config.devCommand, 'npm run dev:edgeone:vite --');
  assert.equal(config.buildCommand, 'npm run build:edgeone');
  assert.equal(config.installCommand, 'npm ci');
  assert.equal(config.outputDirectory, './dist');
  assert.equal(config.nodeVersion, '22.11.0');
  assert.equal(config.cloudFunctions.nodejs.maxDuration, 120);
  assert.deepEqual(config.schedules, [
    {
      name: 'nodewarden-edgeone-backup',
      cron: '0 3 * * *',
      path: '/api/cron/backup',
      method: 'POST',
      timezone: 'UTC',
    },
  ]);
});

test('EdgeOne Cloud Functions expose catch-all API entrypoints', () => {
  const api = readText('cloud-functions/api/[[default]].js');
  const identity = readText('cloud-functions/identity/[[default]].js');
  const config = readText('cloud-functions/config.js');

  assert.match(api, /handleEdgeOnePagesRequest/);
  assert.match(identity, /handleEdgeOnePagesRequest/);
  assert.match(config, /handleEdgeOnePagesRequest/);
  assert.match(api, /_generated\/edgeone-handler\.mjs/);
  assert.match(identity, /_generated\/edgeone-handler\.mjs/);
  assert.match(config, /_generated\/edgeone-handler\.mjs/);
});

test('generic handlers import notification helpers without cloudflare runtime dependency', () => {
  const genericHandlerFiles = [
    'src/handlers/attachments.ts',
    'src/handlers/backup.ts',
    'src/handlers/ciphers.ts',
    'src/handlers/devices.ts',
    'src/handlers/folders.ts',
    'src/handlers/import.ts',
    'src/handlers/sends-shared.ts',
  ];

  for (const file of genericHandlerFiles) {
    assert.doesNotMatch(readText(file), /durable\/notifications-hub/);
  }

  assert.match(readText('src/services/notifications.ts'), /notifyUserVaultSync/);
  assert.doesNotMatch(readText('src/services/notifications.ts'), /cloudflare:workers/);
});
