// Small native commands: the dashboard brief and "open this path" (home only).
import { shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readBrief(home = os.homedir()): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.local/share/hub-dashboard/brief/latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Canonicalize (resolving symlinks) and only open things inside $HOME. */
export async function openPath(p: string, home = os.homedir()): Promise<void> {
  const real = fs.realpathSync(p);
  const h = fs.realpathSync(home);
  if (real !== h && !real.startsWith(h + path.sep)) throw new Error('outside home');
  const err = await shell.openPath(real);
  if (err) throw new Error(err);
}

/** Pure check used by the self-test (does not open anything). */
export function insideHome(p: string, home = os.homedir()): boolean {
  try {
    const real = fs.realpathSync(p);
    const h = fs.realpathSync(home);
    return real === h || real.startsWith(h + path.sep);
  } catch {
    return false;
  }
}
