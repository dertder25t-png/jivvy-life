// Packages the built app (run `npm run electron:build` first; `npm run electron:package` does both)
// for linux-x64 into out/jivvy-life-linux-x64/. Only runtime files go in: dist/ (renderer),
// dist-electron/ (main, preload, workers, ad-block domain list), assets/icons and package.json.
// Everything else is bundled by esbuild/vite, so node_modules is left out on purpose.
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const must = ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.js', 'dist-electron/blocklist-domains.json'];
for (const f of must) if (!fs.existsSync(path.join(root, f))) throw new Error(`Missing ${f}: run npm run electron:build first`);

// Paths (relative to the app root, with a leading slash) that are allowed into the package.
const KEEP = ['/package.json', '/dist', '/dist-electron', '/assets/icons'];
const ignore = (file) => {
  if (!file) return false; // the root itself
  if (file.endsWith('.map')) return true;
  return !KEEP.some((k) => file === k || file.startsWith(k + '/') || k.startsWith(file + '/'));
};

const out = path.join(root, 'out');
fs.rmSync(path.join(out, 'jivvy-life-linux-x64'), { recursive: true, force: true });
const dirs = await packager({
  dir: root,
  out,
  name: 'jivvy-life',
  executableName: 'jivvy-life',
  platform: 'linux',
  arch: 'x64',
  electronVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version,
  appVersion: pkg.version,
  asar: false,
  prune: false,
  overwrite: true,
  ignore,
  quiet: true,
});
console.log('packaged:', dirs.join(', '));
