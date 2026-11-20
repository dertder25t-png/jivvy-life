// selftest group: security. ad blocking, page sandboxing, cookie import, logins, open_path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { session as electronSession, safeStorage } from 'electron';
import { Logins } from '../logins';
import { insideHome } from '../native';
import type { Group } from './kit';

export const security: Group = {
  name: 'security',
  desc: "ad blocking, page sandboxing, cookie import, logins, open_path",
  needs: ['tabs'],
  async run(t) {
    const { ctx, tabs, result, info, base, ui, tab, sleep, waitFor } = t;
    const yt = tabs.webContentsOf('tab_t2')!;
  // ---- 11. ad blocking ----
  await waitFor(() => ctx.blocker.ready, 10000);
  const probe = ctx.blocker.shouldBlock('https://sb.scorecardresearch.com/beacon.js', 'script', yt.id);
  const firstParty = ctx.blocker.shouldBlock('https://www.youtube.com/s/player.js', 'script', yt.id);
  result(ctx.blocker.ready && probe && !firstParty, 'ad blocking (third-party tracker blocked, first-party allowed)', `${ctx.blocker.rules} rules, ${ctx.blocker.blockedCount} requests blocked so far`);

  // ---- 12. security ----
  const wiki = tabs.webContentsOf('tab_t0')!;
  const noApi = await wiki.executeJavaScript(`typeof window.jivvy === 'undefined' && typeof require === 'undefined' && typeof process === 'undefined'`);
  result(noApi, 'pages get no preload / Node');
  const beforeUrl = wiki.getURL();
  await wiki.executeJavaScript(`location.href = 'file:///etc/hostname'`).catch(() => {});
  await sleep(600);
  result(wiki.getURL() === beforeUrl, 'file:// navigation from a page is blocked');
  const uiNav = base().getURL();
  await ui(`location.href = 'https://example.com/'`).catch(() => {});
  await sleep(500);
  result(base().getURL() === uiNav, 'UI view cannot navigate away');

  // ---- 12b. logins, cookie import, open_path ----
  {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-st-logins-'));
    try {
      // Fake Firefox profile (the real one is never touched; the root is not reachable via IPC).
      const ffRoot = path.join(scratch, 'firefox');
      const prof = path.join(ffRoot, 'abc.default');
      fs.mkdirSync(prof, { recursive: true });
      fs.writeFileSync(path.join(ffRoot, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\nDefault=1\n');
      const fdb = new DatabaseSync(path.join(prof, 'cookies.sqlite'));
      fdb.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT DEFAULT \'\')');
      const ins = fdb.prepare('INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,?,?,?)');
      const future = Math.floor(Date.now() / 1000) + 86400;
      ins.run('sid', 'abc123', '.example.test', '/', future, 1, 1, 2);
      ins.run('hostonly', 'v', 'app.example.test', '/p', future * 1000, 0, 0, 1);
      ins.run('old', 'x', '.example.test', '/', Math.floor(Date.now() / 1000) - 100, 0, 0, 0);
      ins.run('__Host-sid', 'h1', 'accounts.example.test', '/', future * 1000, 1, 1, 0);
      ins.run('__Secure-sid', 's1', '.example.test', '/', future, 1, 1, 0);
      ins.run('none_ss', 'n1', 'api.example.test', '/', future, 1, 0, 0);
      fdb.prepare("INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,sameSite,originAttributes) VALUES ('sid','part','.example.test','/',?,1,1,0,'^partitionKey=%28https%2Cother.test%29')").run(future);
      fdb.close();
      const ses = electronSession.fromPartition(`jivvy-selftest-${Date.now()}`);
      const lg = new Logins({ userData: path.join(scratch, 'ud'), session: () => ses, webContentsOf: (id) => tabs.webContentsOf(id), firefoxRoots: [ffRoot] });
      const ci = await lg.importFirefoxCookies();
      const got = await ses.cookies.get({});
      const sid = got.find((c) => c.name === 'sid');
      const ho = got.find((c) => c.name === 'hostonly');
      result(
        ci.imported === 5 && ci.skipped === 2 && ci.reasons.some((x) => x.reason === 'expired' && x.count === 1) && ci.reasons.some((x) => x.count === 1 && x.names.includes('sid')) && ci.profile === 'abc.default' && !!sid && sid.domain === ".example.test" && !!sid.secure && !!sid.httpOnly && sid.sameSite === 'strict' && !!ho && ho.path === '/p' && !ho.domain?.startsWith('.') && !got.some((c) => c.name === 'old'),
        'cookie import from fake Firefox profile (expired skipped, flags kept)',
        JSON.stringify(ci)
      );
      const hostC = got.find((c) => c.name === '__Host-sid');
      const secC = got.find((c) => c.name === '__Secure-sid');
      const noneC = got.find((c) => c.name === 'none_ss');
      result(
        !!hostC && hostC.domain === 'accounts.example.test' && hostC.path === '/' && !!hostC.secure && hostC.sameSite === 'no_restriction' && !!hostC.expirationDate && hostC.expirationDate < Date.now() / 1000 + 2 * 86400 &&
          !!secC && !!secC.secure && secC.domain === '.example.test' && !!noneC && noneC.sameSite === 'no_restriction' && got.filter((c) => c.name === 'sid').length === 1 && sid?.sameSite === 'strict',
        'cookie import: __Host-/__Secure-/SameSite=None/ms expiry kept; partitioned copy cannot overwrite real cookie',
        JSON.stringify(ci.reasons)
      );
      result(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('jivvy-ffcookies-')), 'cookie import temp copy deleted');

      const csv = 'url,username,password,httpRealm,formActionOrigin\r\nhttps://login.example.test/,alice,"p,ass""w\nd",,\nhttps://login.example.test/,bob,pw2,,\nhttp://x.test/,carol,pw3,Realm,\nftp://y/,dave,pw,,\n';
      let avail = false;
      let backend = 'n/a';
      try {
        avail = safeStorage.isEncryptionAvailable();
        backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'native';
      } catch {
        /* not ready */
      }
      info('safeStorage', `available=${avail} backend=${backend}`);
      if (avail && backend !== 'basic_text' && backend !== 'unknown') {
        const r = lg.importPasswordsCsv(csv);
        const users = lg.loginsFor('https://login.example.test/account').sort();
        const idx = path.join(scratch, 'ud', 'logins_index.json');
        const raw = fs.readFileSync(idx, 'utf8');
        const mode = fs.statSync(idx).mode & 0o777;
        result(r.imported === 2 && r.skipped === 2 && users.join() === 'alice,bob' && lg.loginsFor('https://evil.test/').length === 0 && lg.loginsFor('http://login.example.test/').length === 0, 'passwords CSV import + logins_for', JSON.stringify(r));
        result(mode === 0o600 && !raw.includes('pw2') && !raw.includes('ass"w'), 'login index is 0600 and holds no plaintext', `mode ${mode.toString(8)}`);
        result(await lg.fillLogin('tab_nonexistent', 'alice').then(() => false, () => true), 'fill_login refuses an unknown tab');
        result(lg.forgetAll() === 2 && lg.loginsFor('https://login.example.test/').length === 0, 'forget_all_logins');
      } else {
        const refused = (() => {
          try {
            lg.importPasswordsCsv(csv);
            return false;
          } catch (e) {
            return /keyring/i.test(String((e as Error).message));
          }
        })();
        result(refused && !fs.existsSync(path.join(scratch, 'ud', 'logins_index.json')), 'passwords refused cleanly without a keyring (nothing written)');
      }
      const rej = await ui<string>(`window.jivvy.invoke('open_path', { path: '/etc/passwd' }).then(() => 'opened', (e) => String(e.message))`);
      result(rej === 'outside home' && !insideHome('/etc/passwd') && insideHome(os.homedir()), 'open_path rejects /etc/passwd', rej);
      const bad = await ui<string>(`window.jivvy.invoke('open_path', { path: 5 }).then(() => 'opened', (e) => String(e.message))`);
      result(bad === 'Bad path', 'open_path validates argument types', bad);
      const rb = await ui<string>(`window.jivvy.invoke('read_brief').then((v) => v === null || typeof v === 'object' ? 'ok' : 'bad', (e) => String(e.message))`);
      result(rb === 'ok', 'read_brief returns object or null');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  },
};
