// Builds the Electron main process + preload (TypeScript -> dist-electron/*.js with esbuild)
// and the ad-block domain list. Type checking is `tsc -p electron` (see package.json).
//   node scripts/build-electron.mjs          one-off build
//   import { buildElectron } from here       used by electron-dev.mjs (watch mode)
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const outDir = path.join(root, 'dist-electron');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
};
const entries = [
  { entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(outDir, 'main.js') },
  { entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(outDir, 'preload.js') },
  // worker_threads entry for the nightly trainer (electron/trainer.ts spawns dist-electron/trainer-worker.js)
  { entryPoints: [path.join(root, 'electron/trainer-worker.ts')], outfile: path.join(outDir, 'trainer-worker.js') },
];

/**
 * EasyList-derived WebKit content rules -> { block: [domains], allow: [domains] }.
 * Every rule in blocklist.json is a domain rule of the form ^[^:]+://+([^:/]+\.)?DOMAIN[:/];
 * "ignore-previous-rules" entries are the never-block exceptions.
 */
export function buildBlocklist() {
  const src = path.join(root, 'src-tauri/blocklist/blocklist.json');
  const out = path.join(outDir, 'blocklist-domains.json');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return;
  const rules = JSON.parse(fs.readFileSync(src, 'utf8'));
  const PREFIX = '^[^:]+://+([^:/]+\\.)?';
  const SUFFIX = '[:/]';
  const block = new Set();
  const allow = new Set();
  let skipped = 0;
  for (const r of rules) {
    const f = r?.trigger?.['url-filter'];
    if (typeof f !== 'string' || !f.startsWith(PREFIX) || !f.endsWith(SUFFIX)) {
      skipped++;
      continue;
    }
    const domain = f.slice(PREFIX.length, -SUFFIX.length).replace(/\\\./g, '.').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) {
      skipped++;
      continue;
    }
    (r.action?.type === 'ignore-previous-rules' ? allow : block).add(domain);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ block: [...block], allow: [...allow] }));
  console.log(`blocklist: ${block.size} blocked domains, ${allow.size} exceptions, ${skipped} skipped`);
}

function writePkg() {
  fs.mkdirSync(outDir, { recursive: true });
  // app/package.json is "type": "module"; these bundles are CommonJS.
  fs.writeFileSync(path.join(outDir, 'package.json'), '{ "type": "commonjs" }\n');
}

export async function buildElectron() {
  writePkg();
  buildBlocklist();
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}

export async function watchElectron(onRebuild) {
  writePkg();
  buildBlocklist();
  const plugin = { name: 'notify', setup: (b) => b.onEnd((r) => !r.errors.length && onRebuild()) };
  const ctxs = await Promise.all(entries.map((e) => context({ ...common, ...e, plugins: [plugin] })));
  await Promise.all(ctxs.map((c) => c.watch()));
  return ctxs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildElectron();
  console.log('electron: built dist-electron/main.js, preload.js, trainer-worker.js');
}
