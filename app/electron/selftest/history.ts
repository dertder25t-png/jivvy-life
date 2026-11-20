// selftest group: history. local browsing history, typed inputs, Firefox history import (fake profile).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Group } from './kit';

export const history: Group = {
  name: 'history',
  desc: "local browsing history, typed inputs, Firefox history import (fake profile)",
  needs: ['tabs'],
  async run(t) {
    const { ctx, result, ui, dispatch, sleep, waitFor } = t;
  // ---- 3b. local browsing history ----
  {
    const h = ctx.history;
    const titledVisit = (host: string) => h.recent(50).find((v) => v.host === host && v.title);
    await waitFor(() => !!titledVisit('example.com') && !!titledVisit('iana.org'), 15000);
    const ex = titledVisit('example.com');
    const ia = titledVisit('iana.org');
    result(!!ex && !!ia && h.counts().visits >= 2, 'history: visiting pages records visits with titles', `${ex?.title.slice(0, 20)} | ${ia?.title.slice(0, 20)}`);
    const viaUi = await ui<Array<{ host: string }>>(`window.jivvy.historySearch('exam', 5)`);
    const viaUi2 = await ui<Array<{ host: string }>>(`window.jivvy.historySearch('ian', 5)`);
    result(viaUi.some((r) => r.host === 'example.com') && viaUi2.some((r) => r.host === 'iana.org'), 'history:search finds pages by host prefix', `${viaUi.length}+${viaUi2.length} hits`);
    result((await ui<unknown[]>(`window.jivvy.historySearch("100%_\\\\", 5)`)).length === 0, 'history:search escapes LIKE wildcards');
    const typedBefore = h.counts().typed;
    await ui(`window.jivvy.historyTyped({ text: 'exam', url: 'https://example.com/', shownUrl: 'https://example.com/', accepted: true })`);
    result(await waitFor(() => h.counts().typed === typedBefore + 1, 3000), 'history:typed records the typed input');
    const mode = fs.statSync(path.join(ctx.app.getPath('userData'), 'history.sqlite')).mode & 0o777;
    result(mode === 0o600, 'history.sqlite is mode 0600', mode.toString(8));
    await dispatch({ type: 'setPref', key: 'saveHistory', value: false });
    await sleep(100);
    const nv = h.counts();
    h.visit('tab_nope', 'https://off.example.org/', 'x', true);
    await ui(`window.jivvy.historyTyped({ text: 'off', url: '', accepted: false })`);
    await sleep(150);
    const nv2 = h.counts();
    result(nv.visits === nv2.visits && nv.typed === nv2.typed, '"Save browsing history" off records nothing');
    await dispatch({ type: 'setPref', key: 'saveHistory', value: true });
    h.tabClosed('tab_nope');
    h.visit('tab_creds', 'https://user:pw@secret.example.org/', 'x', true);
    result(h.search('secret', 5).length === 0, 'URLs with credentials are never recorded');

    // Firefox import against a fake profile in the scratch dir (never the real one).
    const ffRoot = path.join(ctx.app.getPath('userData'), 'fake-firefox');
    const prof = path.join(ffRoot, 'abc.default-release');
    fs.rmSync(ffRoot, { recursive: true, force: true });
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(ffRoot, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n');
    const fake = new DatabaseSync(path.join(prof, 'places.sqlite'));
    fake.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);`);
    const us = (daysAgo: number) => (Date.now() - daysAgo * 86_400_000) * 1000;
    const places = [
      [1, 'https://www.Imported-Typed.test/home', 'Typed one'],
      [2, 'https://www.google.com/search?q=fake+query', 'fake query - Google Search'],
      [3, 'https://linked.test/a?b=1', 'Linked'],
      [4, 'https://reloaded.test/', 'Reloaded'],
      [5, 'https://ancient.test/', 'Ancient'],
      [6, 'place:sort=8', 'Not a page'],
    ];
    for (const p of places) fake.prepare('INSERT INTO moz_places VALUES (?, ?, ?)').run(...(p as [number, string, string]));
    const vis: Array<[number, number, number]> = [[1, us(5), 2], [2, us(4), 1], [3, us(3), 1], [4, us(2), 9], [5, us(200), 1], [6, us(1), 1]];
    for (const v of vis) fake.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)').run(...v);
    fake.close();
    const tmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('jivvy-ffimport-')).length;
    const tmpBefore = tmpDirs();
    const r1 = await h.importFirefox([ffRoot]);
    const rows = h.raw()!.prepare("SELECT host, transition, query, engine FROM visits WHERE url LIKE '%imported-typed%' OR url LIKE '%google.com/search?q=fake%' OR url LIKE '%linked.test%'").all() as Array<{ host: string; transition: string; query: string | null }>;
    const tr = Object.fromEntries(rows.map((r) => [r.host, r.transition]));
    result(
      r1.state === 'done' && r1.imported === 3 && tr['imported-typed.test'] === 'typed' && tr['google.com'] === 'search' && tr['linked.test'] === 'link',
      'Firefox import: 3 recent visits imported (typed/search/link mapped; reload, >180d, non-http skipped)',
      JSON.stringify({ imported: r1.imported, skipped: r1.skipped, ...tr })
    );
    const r2 = await h.importFirefox([ffRoot]);
    result(r2.imported === 0 && r2.skipped === 3, 'Firefox import: re-import skips duplicates', `imported ${r2.imported}, skipped ${r2.skipped}`);
    result(tmpDirs() === tmpBefore, 'Firefox import: temp copy deleted');
    const stat = await ui<{ state: string; imported: number }>(`window.jivvy.historyImportStatus()`);
    result(stat.state === 'done', 'history:importStatus reports the last import', JSON.stringify(stat));
    fs.rmSync(ffRoot, { recursive: true, force: true });
  }
  },
};
