const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputFile = path.join(root, 'cloud-functions', '_generated', 'edgeone-handler.mjs');
const esbuildBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');

if (!fs.existsSync(esbuildBin)) {
  console.error('esbuild binary not found. Run npm install first.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });

const result = spawnSync(
  esbuildBin,
  [
    'src/edgeone/handler.ts',
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=esm',
    `--outfile=${outputFile}`,
    '--log-level=warning',
  ],
  {
    cwd: root,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status || 0);
