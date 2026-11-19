// npm run electron:dev: Vite dev server (renderer, HMR) + esbuild watch (main/preload) + Electron,
// restarted whenever main or preload changes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import electronPath from 'electron';
import { watchElectron } from './build-electron.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') ?? 'http://localhost:1420';
console.log(`vite: ${url}`);

const extra = process.argv.slice(2);
let child = null;
let restarting = false;
let timer = null;
function start() {
  child = spawn(electronPath, ['--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations', '.', ...extra], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, JIVVY_DEV_URL: url },
  });
  child.on('exit', (code) => {
    if (restarting) return;
    void server.close();
    process.exit(code ?? 0);
  });
}
function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!child) return start();
    restarting = true;
    child.once('exit', () => {
      restarting = false;
      start();
    });
    child.kill();
  }, 150);
}
await watchElectron(restart);
