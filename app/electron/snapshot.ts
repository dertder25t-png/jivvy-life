// Pure helpers shared by main and the worker threads (no electron imports): snapshot validation,
// the compact UI snapshot, and atomic 0600 file writes.
import fs from 'node:fs';
import path from 'node:path';
import type { PredictionSnapshot, UiSnapshot } from '../shared/history-types';

/** The renderer only autocompletes over the best sites; the full list stays on disk. */
export const UI_SITE_CAP = 2000;

/** A snapshot read from disk is only trusted if it has the shape the UI relies on. */
export function validSnapshot(v: unknown): v is PredictionSnapshot {
  const s = v as PredictionSnapshot | null;
  return (
    !!s &&
    typeof s === 'object' &&
    s.version === 1 &&
    Number.isFinite(s.trainedAt) &&
    Array.isArray(s.sites) &&
    Array.isArray(s.sequences) &&
    !!s.aliases &&
    typeof s.aliases === 'object' &&
    !!s.hourly &&
    !!s.weekday
  );
}

/** What complete()/decide() use, nothing else: capped sites without unused fields, hourly for those hosts only. */
export function compactSnapshot(s: PredictionSnapshot, cap = UI_SITE_CAP): UiSnapshot {
  const sites = s.sites.slice(0, cap).map((x) => ({ url: x.url, host: x.host, title: x.title, score: x.score }));
  const hourly: Record<string, number[]> = {};
  for (const x of sites) if (s.hourly[x.host] && !hourly[x.host]) hourly[x.host] = s.hourly[x.host];
  const u: UiSnapshot = {
    version: 1,
    trainedAt: s.trainedAt,
    sites,
    aliases: s.aliases,
    sequences: s.sequences,
    hourly,
    stats: { sites: s.sites.length, aliases: Object.keys(s.aliases).length },
  };
  if (s.classifier !== undefined) u.classifier = s.classifier;
  if (s.params) u.params = s.params;
  if (s.eval) u.eval = s.eval;
  return u;
}

/** temp file (0600) + fsync + rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readSnapshotFile(file: string): PredictionSnapshot | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validSnapshot(v) ? v : null;
  } catch {
    return null;
  }
}
