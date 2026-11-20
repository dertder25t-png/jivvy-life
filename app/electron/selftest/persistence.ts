// selftest group: persistence. state file persistence and memory report.
import fs from 'node:fs';
import path from 'node:path';
import type { Group } from './kit';

export const persistence: Group = {
  name: 'persistence',
  desc: "state file persistence and memory report",
  needs: ['tabs'],
  async run(t) {
    const { ctx, tabs, result, info, dispatch, sleep } = t;
    const yt = tabs.webContentsOf('tab_t2')!;
  // ---- 13. persistence ----
  await sleep(800);
  const file = path.join(ctx.app.getPath('userData'), 'jivvy-state.json');
  const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  result(saved.includes('tab_t2') && saved.includes('"layoutMode"'), 'state persisted to userData/jivvy-state.json', `${saved.length} bytes`);

  // ---- 14. memory ----
  await yt.executeJavaScript(`document.querySelector('video')?.pause()`, true).catch(() => {});
  await dispatch({ type: 'focusTab', tabId: 'tab_t0' });
  await sleep(3000);
  const m = ctx.app.getAppMetrics();
  const total = m.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024;
  const byType = m.map((p) => `${p.type}${p.name ? `(${p.name})` : ''}:${Math.round(p.memory.workingSetSize / 1024)}`).join(' ');
  // Working set double-counts shared pages across processes; PSS splits them fairly.
  const pss = (pid: number) => {
    try {
      const m2 = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      return m2 ? Number(m2[1]) / 1024 : 0;
    } catch {
      return 0;
    }
  };
  const pssTotal = m.reduce((s2, p) => s2 + pss(p.pid), 0);
  if (pssTotal) info('memory (PSS)', `${Math.round(pssTotal)} MB proportional set size total [${m.map((p) => `${p.type}:${Math.round(pss(p.pid))}`).join(' ')}]`);
  info('memory', `3 web tabs (YouTube paused) + UI: ${Math.round(total)} MB total working set across ${m.length} processes [${byType}]`);
  },
};
