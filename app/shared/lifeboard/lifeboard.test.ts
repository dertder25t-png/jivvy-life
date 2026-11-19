// Run: node --test shared/lifeboard/lifeboard.test.ts   (Node 22.18+; no extra dependencies)
//   or: npx tsx --test shared/lifeboard/lifeboard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PredictionSnapshot, TypedInput, Visit } from '../history-types.ts';
import { complete, decide, mergeConfig, train, trainClassifier, classify, BUNDLED_MODEL, isFrustration, seqMatch, canvasPage, matchAlias, matchSequences, normalizeUrl } from './index.ts';

const NOW = new Date(2026, 10, 18, 14, 30).getTime(); // Wed 14:30 local
const DAY = 86400000;
const cfg = mergeConfig();

function visit(url: string, t: number, transition: Visit['transition'] = 'link', extra: Partial<Visit> = {}): Visit {
  const u = new URL(url);
  return { url, host: u.hostname.replace(/^www\./, ''), path: u.pathname, title: extra.title ?? '', t, transition, ...extra };
}
const search = (q: string, t: number): Visit =>
  visit('https://www.google.com/search?q=' + encodeURIComponent(q), t, 'typed', { query: q, engine: 'google' });

// ---------- decide ----------
test('decide: bang prefixes', () => {
  const cases: [string, string, string | undefined][] = [
    ['!s cats', 'search', 'https://www.google.com/search?q=cats'],
    ['!search cats', 'search', 'https://www.google.com/search?q=cats'],
    ['!web hello there', 'claude', 'https://claude.ai/new?q=hello%20there'],
    ['!ask why is the sky blue', 'claude', 'https://claude.ai/new?q=why%20is%20the%20sky%20blue'],
    ['!gpt hi', 'chatgpt', 'https://chatgpt.com/?q=hi'],
    ['!g hi', 'gemini', 'https://gemini.google.com/app'],
    ['!deep history of tea', 'claude-deep', 'https://claude.ai/new?q=history%20of%20tea'],
    ['!code add a button', 'claude-code', undefined],
  ];
  for (const [input, route, url] of cases) {
    const d = decide(input, cfg)!;
    assert.equal(d.route, route, input);
    assert.equal(d.url, url, input);
    assert.equal(d.confidence, 1);
    assert.match(d.why, /^prefix !/);
  }
  assert.equal(decide('!plan build a thing', cfg)!.mode, 'plan');
  assert.equal(decide('!fix typo in readme', cfg)!.mode, 'direct');
  assert.equal(decide('   ', cfg), null);
  assert.equal(decide('!nope cats', cfg)!.source !== 'prefix', true);
});

test('decide: rule priorities, classifier, fallback, calc hint', () => {
  assert.equal(decide('github.com/foo', cfg)!.route, 'open-url');
  assert.equal(decide('github.com/foo', cfg)!.url, 'https://github.com/foo');
  assert.equal(decide('why does this crash in src/app.tsx', cfg)!.route, 'claude-code');
  assert.equal(decide('weather', cfg)!.route, 'search');
  const proj = mergeConfig({ allProjects: [{ name: 'hub', path: '/x/hub' }] });
  assert.equal(decide('fix the bug in hub', proj)!.why, 'mentions your project “hub”');
  assert.equal(decide('157919MB to gb', cfg)!.calc, '= 157.92 GB · 147.07 GiB');
  const long = decide('explain how transformers learn long range dependencies in text and why it matters', cfg)!;
  assert.ok(['classifier', 'fallback'].includes(long.source));
  // alias beats web-address-less text; user alias wins over learned
  const snap = { aliases: { drive: 'https://drive.google.com' }, classifier: undefined };
  assert.equal(decide('drive', cfg, snap as never)!.url, 'https://drive.google.com');
  assert.equal(decide('drive', mergeConfig({ navAliases: { drive: 'https://mine.example' } }), snap as never)!.url, 'https://mine.example');
  assert.equal(decide('drvie', cfg, snap as never)!.route, 'search'); // <=5 letters: no typo match
  assert.equal(decide('pinterst', cfg, { aliases: { pinterest: 'https://www.pinterest.com' } } as never)!.route, 'open-url');
  // snapshot classifier is used when present
  const forced = structuredClone(BUNDLED_MODEL);
  forced.bias = { search: -50, ask: 50, deep: -50, code: -50 };
  const d = decide('some long query that is not a lookup at all really', cfg, { aliases: {}, classifier: forced } as never)!;
  assert.equal(d.route, 'claude');
});

// ---------- synthetic history ----------
function synthetic() {
  const visits: Visit[] = [];
  const typed: TypedInput[] = [];
  for (let d = 1; d <= 10; d++) {
    const day = NOW - d * DAY;
    // Searching "canvas" then landing on Canvas, a couple times per day
    for (let k = 0; k < 2; k++) {
      const t = day - k * 3600e3;
      visits.push(search('canvas', t));
      visits.push(visit('https://pcci.instructure.com/', t + 4000, 'link', { title: 'Dashboard' }));
      visits.push(visit('https://pcci.instructure.com/courses/12/assignments/3', t + 60e3, 'link', { title: 'Assignment 3' }));
    }
    // A habit: mail -> docs -> drive within 10 minutes
    const h = day - 5 * 3600e3;
    visits.push(visit('https://mail.google.com/mail/u/0/', h, 'typed', { title: 'Inbox' }));
    visits.push(visit('https://accounts.google.com/signin/oauth', h + 20e3, 'link'));
    visits.push(visit('https://docs.google.com/document/d/1', h + 60e3, 'link', { title: 'Notes' }));
    visits.push(visit('https://drive.google.com/drive/my-drive', h + 120e3, 'link', { title: 'My Drive' }));
    visits.push(visit('https://news.ycombinator.com/?utm_source=x#top', h + 3600e3, 'typed', { title: 'Hacker News' }));
  }
  visits.push(visit('https://news.ycombinator.com/', NOW - 1000, 'reload'));
  return { visits, typed };
}

test('train: frecency, normalization, hourly', () => {
  const { visits, typed } = synthetic();
  const snap = train(visits, typed, NOW);
  assert.equal(snap.version, 1);
  const hn = snap.sites.filter((s) => s.host === 'news.ycombinator.com');
  assert.equal(hn.length, 1, 'utm_source/hash stripped, urls merged');
  assert.equal(hn[0].url, 'https://news.ycombinator.com/');
  assert.equal(normalizeUrl('https://a.com/p?utm_medium=1&fbclid=2&gclid=3&x=4#h'), 'https://a.com/p?x=4');
  const mail = snap.sites.find((s) => s.host === 'mail.google.com')!;
  assert.equal(mail.typed, 10);
  // exact frecency: one typed visit 14 days ago, weight 2 -> 1.0
  const one = train([visit('https://once.example.com/', NOW - 14 * DAY, 'typed'), visit('https://once.example.com/', NOW - 14 * DAY, 'reload')], [], NOW);
  assert.ok(Math.abs(one.sites[0].score - 1) < 1e-3);
  assert.equal(one.sites[0].visits, 2);
  assert.ok(!snap.sites.some((s) => s.url.includes('/search?q=')), 'search result pages are not destinations');
  assert.equal(snap.hourly['mail.google.com'].reduce((a, b) => a + b, 0), 10);
  assert.equal(snap.weekday['mail.google.com'].length, 7);
  // accepted typed suggestion adds +1.0
  const base = train(visits, [], NOW).sites.find((s) => s.host === 'drive.google.com')!.score;
  const acc: TypedInput[] = [{ text: 'dr', url: 'https://drive.google.com/drive/my-drive', accepted: true, t: NOW - 1000 }];
  const withAcc = train(visits, acc, NOW).sites.find((s) => s.host === 'drive.google.com')!.score;
  assert.ok(Math.abs(withAcc - base - 1) < 1e-3);
  // determinism
  assert.deepEqual(train(visits, typed, NOW), train([...visits].reverse(), typed, NOW));
  // cap
  const many: Visit[] = Array.from({ length: 6000 }, (_, i) => visit(`https://s${i}.example.com/`, NOW - i * 1000));
  assert.equal(train(many, [], NOW).sites.length, 5000);
});

test('train: Canvas alias from search -> site pairs, plus typed aliases', () => {
  const { visits } = synthetic();
  const typed: TypedInput[] = [
    { text: 'hn', url: 'https://news.ycombinator.com/', accepted: true, t: NOW },
    { text: 'mail', url: 'https://mail.google.com/mail/u/0/', accepted: false, t: NOW },
    { text: 'mail', url: 'https://mail.google.com/mail/u/0/', accepted: false, t: NOW + 1 },
    { text: 'once', url: 'https://example.org/', accepted: false, t: NOW },
  ];
  const snap = train(visits, typed, NOW);
  assert.equal(snap.aliases['canvas'], 'https://pcci.instructure.com');
  assert.equal(snap.aliases['hn'], 'https://news.ycombinator.com/');
  assert.equal(snap.aliases['mail'], 'https://mail.google.com/mail/u/0/');
  assert.equal(snap.aliases['once'], undefined);
  assert.equal(matchAlias('canvs', snap.aliases), null); // <=5 letters: exact only
  assert.equal(decide('canvas', cfg, snap)!.url, 'https://pcci.instructure.com');
  assert.equal(decide('canvas', cfg, snap)!.why, 'you usually go here');
});

test('train: sequence mining drops SSO and needs n>=4 on 3 days', () => {
  const { visits } = synthetic();
  const snap = train(visits, [], NOW);
  const s = snap.sequences.find((x) => x.hosts.join() === 'mail.google.com,docs.google.com,drive.google.com');
  assert.ok(s, 'sequence found across the accounts.google.com sign-in');
  assert.equal(s!.n, 10);
  assert.equal(s!.days, 10);
  assert.equal(s!.url, 'https://drive.google.com/drive/my-drive');
  // only 2 days -> not a pattern
  const few = visits.filter((v) => v.t > NOW - 3 * DAY);
  assert.equal(train(few, [], NOW).sequences.length, 0);
  // runtime match against the ring
  const ring = [{ kind: 'visit', t: NOW - 60e3, host: 'mail.google.com' }, { kind: 'visit', t: NOW - 30e3, host: 'docs.google.com' }];
  assert.equal(seqMatch(ring, s!.hosts, NOW), true);
  assert.equal(matchSequences(ring, snap, NOW).length, 1);
  assert.equal(seqMatch(ring, s!.hosts, NOW + 20 * 60e3), false);
});

test('train: classifier retrain with corrections', () => {
  const m = trainClassifier([{ text: 'zorbl quux', cls: 'code' }]);
  assert.equal(classify(m, 'zorbl quux').cls, 'code');
  assert.equal(classify(m, 'weather tomorrow').cls, 'search');
  const snap = train([], [], NOW, undefined, { corrections: [{ text: 'zorbl quux', cls: 'code' }] });
  assert.ok(snap.classifier);
  assert.equal(train([], [], NOW, snap).classifier, snap.classifier, 'kept from prev');
});

// ---------- complete ----------
function makeSnapshot(n: number): PredictionSnapshot {
  const sites: PredictionSnapshot['sites'] = [];
  const hourly: Record<string, number[]> = {};
  for (let i = 0; i < n; i++) {
    const host = i % 7 === 0 ? `cantina${i}.example.com` : `site${i}.example.org`;
    sites.push({ url: `https://${host}/page/${i}`, host, title: `Page ${i} about things`, score: n - i, visits: 3, typed: 1, lastT: NOW });
    if (i < 300) hourly[host] = Array.from({ length: 24 }, (_, h) => (h === 14 ? 5 : 1));
  }
  sites.push({ url: 'https://pcci.instructure.com/', host: 'pcci.instructure.com', title: 'Dashboard', score: 50, visits: 40, typed: 5, lastT: NOW });
  sites.push({ url: 'https://canvas.example.edu/', host: 'canvas.example.edu', title: 'Canvas', score: 5000, visits: 40, typed: 5, lastT: NOW });
  sites.sort((a, b) => b.score - a.score);
  return { version: 1, trainedAt: NOW, sites, aliases: { canvas: 'https://pcci.instructure.com' }, sequences: [], hourly, weekday: {} };
}

test('complete: inline fill and ranking', () => {
  const snap: PredictionSnapshot = {
    version: 1, trainedAt: NOW, aliases: { canvas: 'https://pcci.instructure.com' }, sequences: [], hourly: {}, weekday: {},
    sites: [
      { url: 'https://pcci.instructure.com/', host: 'pcci.instructure.com', title: 'Dashboard', score: 9, visits: 9, typed: 3, lastT: NOW },
      { url: 'https://github.com/me', host: 'github.com', title: 'GitHub', score: 8, visits: 9, typed: 3, lastT: NOW },
      { url: 'https://mail.github.com/', host: 'mail.github.com', title: 'Mail', score: 1, visits: 1, typed: 0, lastT: NOW },
      { url: 'https://example.com/gitlab-docs/intro', host: 'example.com', title: 'Intro to Git Hooks', score: 2, visits: 1, typed: 0, lastT: NOW },
    ],
  };
  // alias prefix: "can" -> the Canvas site (no inline: host doesn't start with the text)
  let r = complete('can', snap, undefined, NOW);
  assert.equal(r.url, 'https://pcci.instructure.com/');
  assert.equal(r.suggestions[0].reason, 'alias');
  assert.equal(r.inline, undefined);
  // exact alias
  assert.equal(complete('canvas', snap, undefined, NOW).url, 'https://pcci.instructure.com/');
  // host prefix, inline suffix
  r = complete('git', snap, undefined, NOW);
  assert.equal(r.inline, 'hub.com');
  assert.equal(r.suggestions[0].host, 'github.com');
  assert.deepEqual(r.suggestions.map((s) => s.reason), ['host', 'host', 'title']);
  // label after a dot
  assert.equal(complete('mail', snap, undefined, NOW).suggestions[0].host, 'mail.github.com');
  assert.equal(complete('mail', snap, undefined, NOW).inline, 'github.com'.length ? '.github.com' : '');
  // no inline for text with a space / empty
  assert.equal(complete('git ho', snap, undefined, NOW).inline, undefined);
  assert.equal(complete('git ho', snap, undefined, NOW).suggestions[0].reason, 'title');
  assert.deepEqual(complete('  ', snap).suggestions, []);
  // path prefix
  assert.equal(complete('gitlab', snap, undefined, NOW).suggestions[0].reason, 'path');
  // host-prefixed canvas site fills inline
  const s2 = makeSnapshot(50);
  r = complete('can', s2, undefined, NOW);
  assert.equal(r.url, 'https://canvas.example.edu/');
  assert.equal(r.inline, 'vas.example.edu');
  assert.ok(r.suggestions.length <= 6);
  // recent visits count before retraining
  const rv = [visit('https://cantaloupe.org/', NOW - 1000, 'typed')];
  assert.ok(complete('cant', snap, rv, NOW).suggestions.some((s) => s.host === 'cantaloupe.org'));
});

test('complete: time-of-day boost', () => {
  const mk = (host: string, hourly: number[]) => ({ url: `https://${host}/`, host, title: '', score: 10, visits: 1, typed: 0, lastT: NOW, h: hourly });
  const morning = Array.from({ length: 24 }, (_, h) => (h >= 7 && h <= 9 ? 10 : 0));
  const afternoon = Array.from({ length: 24 }, (_, h) => (h >= 13 && h <= 15 ? 10 : 0));
  const a = mk('apple-morning.com', morning), b = mk('apple-afternoon.com', afternoon);
  const snap: PredictionSnapshot = {
    version: 1, trainedAt: NOW, aliases: {}, sequences: [], weekday: {},
    hourly: { [a.host]: a.h, [b.host]: b.h },
    sites: [a, b].map(({ h, ...s }) => s),
  };
  assert.equal(complete('apple', snap, undefined, NOW).suggestions[0].host, 'apple-afternoon.com'); // 14:30
  assert.equal(complete('apple', snap, undefined, new Date(2026, 10, 18, 8).getTime()).suggestions[0].host, 'apple-morning.com');
});

// ---------- moves ----------
test('moves: frustration, canvas page', () => {
  const g = (q: string, t: number) => ({ kind: 'visit', engine: 'google', query: q, t });
  assert.deepEqual(isFrustration([g('fuji xt4 battery life', NOW - 20e3), g('fuji xt4 battery life hours', NOW - 2e3)], NOW)!.queries.length, 2);
  assert.equal(isFrustration([g('cats', NOW - 20e3), g('quantum tax law', NOW - 2e3)], NOW), null);
  assert.deepEqual(canvasPage('https://pcci.instructure.com/courses/12/quizzes/9?x=1'), { courseId: '12', kind: 'quiz' });
  assert.equal(canvasPage('https://example.com/courses/12/quizzes/9'), null);
});

// ---------- time budgets ----------
test('budget: complete() < 2 ms for 5,000 sites', () => {
  const snap = makeSnapshot(5000);
  complete('can', snap, undefined, NOW); // builds the per-snapshot index (once per training run)
  const inputs = ['c', 'ca', 'can', 'canv', 'site12', 'page 40', 'cantina', 'zzz', 'dash', 'ex'];
  const runs = 300;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) complete(inputs[i % inputs.length], snap, undefined, NOW);
  const avg = (performance.now() - t0) / runs;
  const f0 = performance.now();
  complete('can', makeSnapshot(5000), undefined, NOW);
  const first = performance.now() - f0;
  console.log(`complete(): avg ${avg.toFixed(3)} ms/call over ${runs} calls; first call incl. index build ${first.toFixed(2)} ms`);
  assert.ok(avg < 2, `avg ${avg} ms`);
});

test('budget: train() < 3 s for 50k visits (with classifier retrain)', () => {
  const visits: Visit[] = [];
  const hosts = Array.from({ length: 400 }, (_, i) => `site${i}.example.com`);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 50000; i++) {
    const h = hosts[Math.floor(rnd() * rnd() * hosts.length)];
    const t = NOW - Math.floor(rnd() * 90 * DAY);
    const r = rnd();
    if (r < 0.1) visits.push(search('query ' + Math.floor(rnd() * 200), t));
    else visits.push(visit(`https://${h}/p/${Math.floor(rnd() * 40)}?utm_source=a`, t, r < 0.3 ? 'typed' : 'link', { title: 'T ' + h }));
  }
  const typed: TypedInput[] = Array.from({ length: 2000 }, (_, i) => ({ text: 't' + (i % 50), url: `https://${hosts[i % 20]}/`, accepted: i % 3 === 0, t: NOW - i * 1000 }));
  const t0 = performance.now();
  const snap = train(visits, typed, NOW, undefined, { corrections: [{ text: 'zorbl', cls: 'code' }] });
  const ms = performance.now() - t0;
  console.log(`train(): 50k visits -> ${snap.sites.length} sites, ${snap.sequences.length} sequences, ${Object.keys(snap.aliases).length} aliases in ${ms.toFixed(0)} ms (incl. classifier retrain)`);
  assert.ok(ms < 3000, `${ms} ms`);
});

// ---------- params, evaluate, tuning ----------
import { DEFAULT_PARAMS, evaluate, objective, shouldPromote, synthHistory, tune, parseLog, appendLog, regression, trend, runBench, findTargets } from './index.ts';
import type { EvalMetrics } from '../history-types.ts';

const SYN = synthHistory();
const SPLIT = SYN.now - 7 * DAY;

test('params: default params reproduce the original behaviour and are stored in the snapshot', () => {
  const a = train(SYN.visits, SYN.typed, SYN.now);
  const b = train(SYN.visits, SYN.typed, SYN.now, null, { params: { ...DEFAULT_PARAMS } });
  assert.deepEqual(a.params, DEFAULT_PARAMS);
  assert.deepEqual(a.sites, b.sites);
  const c = train(SYN.visits, SYN.typed, SYN.now, null, { params: { halfLifeDays: 3 } });
  assert.equal(c.params!.halfLifeDays, 3);
  assert.notDeepEqual(c.sites.map((s) => s.score), a.sites.map((s) => s.score));
  // complete() falls back to the defaults for a snapshot without params, and honours snapshot.params
  const { params: _p, ...old } = a;
  assert.deepEqual(complete('git', old as PredictionSnapshot, [], SYN.now), complete('git', a, [], SYN.now));
  assert.equal(complete('git', { ...a, params: { ...DEFAULT_PARAMS, inlineMinChars: 5 } }, [], SYN.now).inline, undefined);
});

test('evaluate: synthetic history meets sanity thresholds and is deterministic', () => {
  const m = evaluate(SYN.visits, SYN.typed, undefined, { splitAt: SPLIT, now: SYN.now });
  assert.equal(m.mode, 'typed');
  assert.ok(m.n >= 30, `n=${m.n}`);
  assert.ok(m.top3[1] >= 0.6, `top3@2 ${m.top3[1]}`);
  assert.ok(m.top1[1] >= 0.5, `top1@2 ${m.top1[1]}`);
  assert.ok(m.top3[2] >= m.top3[0] && m.top1[2] >= m.top1[0]);
  assert.ok(m.keystrokesSavedPct > 40 && m.meanCharsToTop1 <= 3);
  assert.ok(m.aliasPrecision === null || m.aliasPrecision >= 0.8);
  assert.ok(m.p95Ms < 25);
  const again = evaluate(SYN.visits, SYN.typed, undefined, { splitAt: SPLIT, now: SYN.now });
  const { p95Ms: _a, trainMs: _b, ...x } = m;
  const { p95Ms: _c, trainMs: _d, ...y } = again;
  assert.deepEqual(x, y);
  assert.deepEqual(synthHistory(), SYN);
});

test('evaluate: falls back to new-session link visits when there are too few typed targets', () => {
  const linkOnly = SYN.visits.map((v) => (v.transition === 'typed' && !v.query ? { ...v, transition: 'link' as const } : v));
  const f = findTargets(linkOnly, [], SPLIT, SYN.now);
  assert.equal(f.mode, 'link-session');
  assert.ok(f.targets.length > 0);
  const m = evaluate(linkOnly, [], undefined, { splitAt: SPLIT, now: SYN.now });
  assert.equal(m.mode, 'link-session');
  assert.ok(m.n > 0 && m.top3[2] > 0.5);
});

test('tune: kept/promoted logic, a deliberately bad candidate is never promoted', () => {
  const cur = evaluate(SYN.visits, SYN.typed, DEFAULT_PARAMS, { splitAt: SPLIT, now: SYN.now });
  const mk = (o: Partial<EvalMetrics>): EvalMetrics => ({ ...cur, ...o });
  assert.equal(shouldPromote(cur, mk({})), false);
  assert.equal(shouldPromote(cur, mk({ top3: [cur.top3[0], cur.top3[1] + 0.005, cur.top3[2]] })), false); // below +0.01
  assert.equal(shouldPromote(cur, mk({ top3: [cur.top3[0], cur.top3[1] + 0.05, cur.top3[2]] })), true);
  // objective gain but top1@2 drops by more than 0.02
  assert.equal(shouldPromote(cur, mk({ top3: [0, 1, 1], top1: [0, cur.top1[1] - 0.05, 1] })), false);
  assert.ok(objective(mk({ wrongInlineRate: 0.5 })) < objective(cur));

  // deliberately bad candidates (zero weight on every visit: nothing is ever suggested): kept
  const bad = tune(SYN.visits, SYN.typed, SYN.now, DEFAULT_PARAMS, { candidates: [{ wTyped: 0, wLink: 0, wSearch: 0, wOther: 0, hourBoost: 0 }, { wTyped: 0, wLink: 0, wSearch: 0, wOther: 0 }] });
  assert.equal(bad.eval.status, 'kept');
  assert.deepEqual(bad.params, DEFAULT_PARAMS);
  // the generated set may promote, but only with a verified gain
  const t = tune(SYN.visits, SYN.typed, SYN.now, undefined);
  assert.ok(t.eval.metrics);
  if (t.eval.status === 'promoted') assert.ok(shouldPromote(t.eval.previous!, t.eval.metrics!));
  else assert.deepEqual(t.params, DEFAULT_PARAMS);
  // an exhausted budget keeps current params
  let clk = 0;
  const slow = tune(SYN.visits, SYN.typed, SYN.now, undefined, { budgetMs: 50, clock: () => (clk += 40) });
  assert.equal(slow.eval.status, 'kept');
  assert.deepEqual(slow.params, DEFAULT_PARAMS);
  // too little data: insufficient, params untouched
  const few = tune(SYN.visits.slice(0, 40), [], SYN.now, undefined);
  assert.equal(few.eval.status, 'insufficient');
});

test('eval log: cap, regression alarm, trend', () => {
  const line = (day: number, v: number) => ({ t: SYN.now - day * DAY, mode: 'typed', n: 50, metrics: { current: null, chosen: { top3: [0, v, 1] } as EvalMetrics }, promoted: false, params: DEFAULT_PARAMS });
  let lines: ReturnType<typeof line>[] = [];
  for (let i = 0; i < 130; i++) lines = appendLog(lines, line(130 - i, 0.8)) as typeof lines;
  assert.equal(lines.length, 120);
  assert.equal(parseLog(lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n').length, 120);
  assert.equal(regression([line(3, 0.9), line(2, 0.86), line(1, 0.82), line(0, 0.78)] as never).alert, true);
  assert.equal(regression([line(3, 0.9), line(2, 0.89), line(1, 0.88), line(0, 0.87)] as never).alert, false); // total <= 0.05
  assert.equal(regression([line(3, 0.9), line(2, 0.86), line(1, 0.87), line(0, 0.78)] as never).alert, false); // not monotone
  assert.equal(trend([line(7, 0.7), line(0, 0.78)] as never, SYN.now), 0.08);
  assert.equal(trend([line(1, 0.7), line(0, 0.78)] as never, SYN.now), null);
});

test('runBench: default vs tuned table', () => {
  const r = runBench(SYN.visits, SYN.typed, SYN.now);
  assert.deepEqual(r.rows.map((x) => x.label), ['default', 'tuned']);
  assert.ok(r.rows[1].metrics.top3[1] >= r.rows[0].metrics.top3[1] - 0.02);
});
