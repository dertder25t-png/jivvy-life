// selftest group: migration. one-time migration from the old Tauri build (fake old dir).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { session as electronSession, safeStorage } from 'electron';
import { Logins } from '../logins';
import { MARKER, autoMigrate, dryRun, fileStateIO, runMigration, shouldAutoMigrate, summaryText, takeMigratedDash, type PasswordReader } from '../migrate-tauri';
import type { Group } from './kit';

export const migration: Group = {
  name: 'migration',
  desc: "one-time migration from the old Tauri build (fake old dir)",
  needs: [],
  async run(t) {
    const { tabs, result, info, base } = t;
  // ---- 12b2. one-time migration from the old Tauri build (fake old dir, scratch userData; the real ones are never touched) ----
  {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-st-migrate-'));
    try {
      const oldDir = path.join(scratch, 'old');
      fs.mkdirSync(path.join(oldDir, 'localstorage'), { recursive: true });
      const u16 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf16le');
      const sdb = new DatabaseSync(path.join(oldDir, 'localstorage', 'tauri_localhost_0.localstorage'));
      sdb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
      const put = sdb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
      const T = '2026-11-18T18:00:00.000Z';
      const wsOld = [{
        id: 'ws_dashboard', name: 'Dashboard', contextTag: 'dashboard', layout: 'single', primaryTabId: 'tab_old_google', secondaryTabId: null, updatedAt: T,
        folders: [{ id: 'fld_a', name: 'classes', collapsed: false }],
        tabs: [
          { id: 'tab_dashboard', title: 'Dashboard', type: 'dashboard', pinned: true, lastActiveAt: T },
          { id: 'tab_old_google', title: 'Google', type: 'web', url: 'https://www.google.com/', lastActiveAt: T },
          { id: 'tab_old_canvas', title: 'Canvas', type: 'web', url: 'https://canvas.example.test/courses', folderId: 'fld_a', lastActiveAt: T },
          { id: 'tab_old_mail', title: 'Mail', type: 'web', url: 'https://mail.example.test/', folderId: 'fld_a', lastActiveAt: T },
          { id: 'tab_old_yt', title: 'YT', type: 'web', url: 'https://www.youtube.com/', lastActiveAt: T },
          { id: 'tab_old_note', title: 'Plan', type: 'note', noteId: 'note_a', lastActiveAt: T },
          { id: 'tab_bad', title: 'Bad', type: 'web', url: 'javascript:alert(1)', lastActiveAt: T },
        ],
      }];
      const notesOld = [
        { id: 'note_welcome', title: 'Welcome Note', content: 'old welcome', tags: [], wikilinks: [], updatedAt: '1970-01-01T00:00:00.000Z' },
        { id: 'note_a', title: 'Plan', content: '# Plan\nfrom the old build', tags: [], wikilinks: [], updatedAt: T },
        { id: 'note_b', title: 'Ideas', content: 'b', tags: ['x'], wikilinks: [], updatedAt: T },
      ];
      put.run('life_app_workspaces_v1', u16(wsOld));
      put.run('life_app_notes_v1', u16(notesOld));
      put.run('life_app_ui_prefs_v1', u16({ showTopBar: false, clearTabsOnStart: true, autoHideAddressBar: true }));
      put.run('life_app_layout_v1', u16('compact-rail')); // the old app wrote this one as a bare string
      put.run('life_app_prefs_meta_v1', u16({ updatedAt: T }));
      put.run('life_app_sync_queue_v1', u16({ workspaces: ['ws_dashboard'], notes: ['note_a', 'note_b'], prefs: false }));
      put.run('life_app_telemetry_queue_v1', u16([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]));
      put.run('lifeapp.dash.links', u16([{ name: 'Claude', url: 'https://claude.ai' }, { name: 'Old site', url: 'https://old-site.example.test' }]));
      put.run('lifeapp.dash.notes', u16(JSON.stringify('old scratch text'))); // the dashboard stores JSON.stringify(value)
      put.run('lifeapp.dash.recent', u16([]));
      sdb.close();
      const wdb = new DatabaseSync(path.join(oldDir, 'webkit_cookies.sqlite'));
      wdb.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)');
      const ck = wdb.prepare('INSERT INTO moz_cookies (name,value,host,path,expiry,lastAccessed,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,0,?,?,?)');
      const fut = Math.floor(Date.now() / 1000) + 86400;
      ck.run('sid', 'OLD-STALE-VALUE', '.example.test', '/', fut, 1, 1, 0);
      ck.run('wk_one', 'v1', '.example.test', '/', fut, 1, 0, 1);
      ck.run('wk_two', 'v2', 'app.example.test', '/p', fut, 0, 0, 0);
      ck.run('wk_old', 'x', '.example.test', '/', Math.floor(Date.now() / 1000) - 50, 0, 0, 0);
      wdb.close();
      fs.writeFileSync(path.join(oldDir, 'logins_index.json'), JSON.stringify({ 'https://login.example.test': ['alice', 'bob'], 'https://other.example.test': ['carol'], 'ftp://nope.test': ['x'] }));
      const fakeReader: PasswordReader = async (want) => ({ found: 3, readable: 1, locked: 0, secrets: want ? new Map([['https://login.example.test|alice', 'fake-test-pw-1']]) : undefined });

      const ud = path.join(scratch, 'ud');
      fs.mkdirSync(ud, { recursive: true });
      const ses = electronSession.fromPartition(`jivvy-selftest-mig-${Date.now()}`);
      await ses.cookies.set({ url: 'https://example.test/', domain: '.example.test', name: 'sid', value: 'FRESH-FROM-FIREFOX', path: '/', secure: true, expirationDate: fut });
      const lg = new Logins({ userData: ud, session: () => ses, webContentsOf: () => null });
      const io = fileStateIO(ud);
      const opts = { userData: ud, oldDir, session: () => ses, logins: lg, state: io, readPasswords: fakeReader };
      const stateFile = path.join(ud, 'jivvy-state.json');
      const urlsOf = () => io.get().workspaces.flatMap((w) => w.tabs.map((t) => t.url).filter(Boolean)) as string[];

      const prevNo = process.env.JIVVY_NO_MIGRATE;
      process.env.JIVVY_NO_MIGRATE = '1';
      const gated = shouldAutoMigrate(ud, oldDir);
      delete process.env.JIVVY_NO_MIGRATE;
      result(!gated && shouldAutoMigrate(ud, oldDir) && !shouldAutoMigrate(ud, path.join(scratch, 'missing')), 'migration gate: needs old dir, no marker, JIVVY_NO_MIGRATE unset');
      if (prevNo !== undefined) process.env.JIVVY_NO_MIGRATE = prevNo;

      // dry run: counts only, writes nothing
      const dr = await dryRun(oldDir, fakeReader);
      result(
        dr.tabs === 5 && dr.folders === 1 && dr.notes === 3 && dr.cookiesFound === 4 && dr.cookiesUsable === 3 && dr.loginsFound === 3 && dr.passwordsReadable === 1 && dr.queues.sync === 3 && dr.queues.telemetry === 3 && fs.readdirSync(ud).length === 0,
        'migration dry run: counts only, writes nothing',
        JSON.stringify(dr)
      );

      io.apply(io.get()); // the user's existing Electron state, so there is something to back up
      // first run on the default state: old workspaces REPLACE it
      const r1 = await autoMigrate(opts);
      const s1 = io.get();
      const ws1 = s1.workspaces[0];
      result(!!r1 && r1.firstRun && r1.replaced && r1.tabs === 5 && r1.folders === 1 && r1.notes === 2, 'migration: first run replaces default tabs with the old workspaces', JSON.stringify(r1 && { ...r1, errors: r1.errors }));
      result(
        urlsOf().includes('https://canvas.example.test/courses') && !urlsOf().some((u) => u.startsWith('javascript:')) && ws1.folders?.some((f) => f.name === 'classes') === true &&
          ws1.tabs.filter((t) => t.folderId === 'fld_a').length === 2 && !ws1.tabs.some((t) => t.id === 'tab_jivvy') && ws1.tabs.some((t) => t.type === 'dashboard'),
        'migration: tabs and folders appear (folder membership kept, invalid URL dropped)'
      );
      const nA = s1.notes.find((n) => n.id === 'note_a');
      result(!!nA && s1.notes.some((n) => n.id === 'note_b') && s1.notes.find((n) => n.id === 'note_welcome')?.content !== 'old welcome', 'migration: notes merged by id, newer updatedAt wins (an equal timestamp keeps the existing note)');
      result(s1.layoutMode === 'compact-rail' && s1.showTopBar === false && s1.clearTabsOnStart === false, 'migration: layout and UI prefs converted (clearTabsOnStart not carried over)');
      const got = await ses.cookies.get({});
      result(
        got.find((c) => c.name === 'sid')?.value === 'FRESH-FROM-FIREFOX' && got.filter((c) => c.name === 'sid').length === 1 && !!got.find((c) => c.name === 'wk_one') && got.find((c) => c.name === 'wk_two')?.path === '/p' && !got.some((c) => c.name === 'wk_old') &&
          r1?.cookies.imported === 2 && r1.cookies.skipped === 2,
        'migration: existing cookie is not overwritten; others imported; expired skipped',
        JSON.stringify(r1?.cookies)
      );
      const bk = fs.readdirSync(ud).filter((n) => n.startsWith('backup-before-migration-'));
      result(bk.length === 1 && fs.existsSync(path.join(ud, bk[0])), 'migration: backup dir created before changes', bk.join());
      const marker = JSON.parse(fs.readFileSync(path.join(ud, MARKER), 'utf8'));
      result(marker.tabs === 5 && marker.notes === 2 && marker.cookies.imported === 2 && marker.skippedQueues.sync === 3 && marker.skippedQueues.telemetry === 3 && marker.runs === 1 && !!marker.at, 'migration: marker written with counts', JSON.stringify({ ...marker, errors: undefined }));
      result(summaryText(r1!) === `Moved 5 tabs, 2 notes, ${r1!.logins.withPassword + r1!.logins.usernamesOnly} logins from the old Jivvy`, 'migration: toast text', summaryText(r1!));
      const names = lg.loginsFor('https://login.example.test/').sort().join();
      const idxRaw = fs.existsSync(path.join(ud, 'logins_index.json')) ? fs.readFileSync(path.join(ud, 'logins_index.json'), 'utf8') : '';
      result(names === 'alice,bob' && lg.loginsFor('https://other.example.test/').join() === 'carol' && r1!.logins.withPassword + r1!.logins.usernamesOnly === 3 && !idxRaw.includes('fake-test-pw-1'), 'migration: logins index carried over (no plaintext password on disk)', JSON.stringify(r1?.logins));
      info('migration passwords', lg.keyringUsable() ? `keyring usable: ${r1?.logins.withPassword} stored encrypted` : `no keyring here: ${r1?.logins.usernamesOnly} username-only`);
      const dashD = takeMigratedDash(ud);
      result(Array.isArray(dashD?.links) && (dashD!.links as unknown[]).length === 2 && dashD?.notes === 'old scratch text' && takeMigratedDash(ud) === null, 'migration: dashboard keys handed over exactly once');
      result(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('jivvy-migrate-')), 'migration: temp copies deleted');

      // second automatic run is a no-op
      const before = fs.readFileSync(stateFile, 'utf8');
      const r2 = await autoMigrate(opts);
      result(r2 === null && fs.readFileSync(stateFile, 'utf8') === before && fs.readdirSync(ud).filter((n) => n.startsWith('backup-before-migration-')).length === 1, 'migration: second automatic run is a no-op');

      // button re-run: merge, never duplicate, never clobber later edits
      const cur = io.get();
      const edited = cur.notes.map((n) => (n.id === 'note_a' ? { ...n, content: 'EDITED LATER', updatedAt: new Date().toISOString() } : n));
      io.apply({ ...cur, notes: edited, workspaces: cur.workspaces.map((w, i) => (i === 0 ? { ...w, tabs: [...w.tabs, { id: 'tab_user_new', title: 'User', type: 'web' as const, url: 'https://user.example.test/', lastActiveAt: T }] } : w)) });
      const r3 = await runMigration(opts);
      const s3 = io.get();
      const count = (u: string) => s3.workspaces.flatMap((w) => w.tabs).filter((t) => t.url === u).length;
      result(
        !r3.replaced && r3.tabs === 0 && r3.folders === 0 && r3.notes === 0 && count('https://canvas.example.test/courses') === 1 && count('https://www.google.com/') === 1 && count('https://user.example.test/') === 1 &&
          s3.workspaces[0].folders?.filter((f) => f.name === 'classes').length === 1 && s3.notes.find((n) => n.id === 'note_a')?.content === 'EDITED LATER' && s3.notes.length === edited.length &&
          r3.cookies.imported === 0 && (await ses.cookies.get({ name: 'sid' })).length === 1 && JSON.parse(fs.readFileSync(path.join(ud, MARKER), 'utf8')).runs === 2,
        'migration: button re-run merges without duplicates (later edits and newer notes kept)',
        JSON.stringify({ tabs: r3.tabs, folders: r3.folders, notes: r3.notes, cookies: r3.cookies })
      );

      // merge path: a profile that already has a user folder keeps everything and gets the old tabs appended
      const ud2 = path.join(scratch, 'ud2');
      fs.mkdirSync(ud2, { recursive: true });
      const io2 = fileStateIO(ud2);
      const base = io2.get();
      io2.apply({
        ...base,
        workspaces: base.workspaces.map((w) => ({
          ...w,
          folders: [{ id: 'fld_mine', name: 'mine' }, { id: 'fld_a', name: 'something else' }],
          tabs: [...w.tabs, { id: 'tab_mine', title: 'Mine', type: 'web' as const, url: 'https://mine.example.test/', folderId: 'fld_mine', lastActiveAt: T }, { id: 'tab_old_google', title: 'Google dup id', type: 'web' as const, url: 'https://google-other.example.test/', lastActiveAt: T }],
        })),
      });
      const r4 = await runMigration({ ...opts, userData: ud2, state: io2, logins: new Logins({ userData: ud2, session: () => ses, webContentsOf: () => null }) });
      const s4 = io2.get();
      const w4 = s4.workspaces[0];
      const ids4 = w4.tabs.map((t) => t.id);
      result(
        !r4.replaced && r4.tabs === 5 && w4.tabs.some((t) => t.id === 'tab_mine') && w4.tabs.some((t) => t.id === 'tab_jivvy') && new Set(ids4).size === ids4.length && w4.tabs.filter((t) => t.url === 'https://www.google.com/').length === 1 &&
          w4.folders?.some((f) => f.id === 'fld_mine') === true && w4.folders?.filter((f) => f.name === 'classes').length === 1 && !!w4.tabs.find((t) => t.url === 'https://canvas.example.test/courses')?.folderId &&
          w4.tabs.find((t) => t.url === 'https://canvas.example.test/courses')?.folderId !== 'fld_a',
        'migration: with user folders it merges (appends old tabs/folders, keeps existing, no id clashes)',
        JSON.stringify({ tabs: r4.tabs, folders: r4.folders, total: w4.tabs.length })
      );
      result(fs.existsSync(path.join(ud2, MARKER)) && fs.readdirSync(ud2).some((n) => n.startsWith('backup-before-migration-')), 'migration: merge run also backs up and writes the marker');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  },
};
