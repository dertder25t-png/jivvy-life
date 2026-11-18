// Request router ported from Lifeboard (core/router.js, rules/basic.js, core/calc.js).
// Pure functions only: cheap enough to run on every keystroke.

export type RouteId = 'search' | 'claude' | 'claude-deep' | 'chatgpt' | 'gemini' | 'open-url';
export type RouteCls = 'search' | 'ask' | 'deep' | 'url';

export interface RouteDecision {
  route: RouteId;
  label: string;
  cls: RouteCls;
  url: string;
  text: string;
  why: string;
  copy?: boolean;
  hint?: string;
}

const enc = encodeURIComponent;

const ROUTES: Record<
  RouteId,
  { label: string; cls: RouteCls; url: (q: string) => string; copy?: boolean; hint?: string }
> = {
  search: { label: 'Google', cls: 'search', url: (q) => `https://www.google.com/search?q=${enc(q)}` },
  claude: { label: 'Claude', cls: 'ask', url: (q) => `https://claude.ai/new?q=${enc(q)}` },
  'claude-deep': {
    label: 'Claude Research',
    cls: 'deep',
    url: (q) => `https://claude.ai/new?q=${enc(q)}`,
    hint: 'Turn on Research in the message box, then press send.',
  },
  chatgpt: { label: 'ChatGPT', cls: 'ask', url: (q) => `https://chatgpt.com/?q=${enc(q)}` },
  gemini: {
    label: 'Gemini',
    cls: 'ask',
    url: () => 'https://gemini.google.com/app',
    copy: true,
    hint: 'Your text is on the clipboard. Paste it into Gemini.',
  },
  'open-url': {
    label: 'Open address',
    cls: 'url',
    url: (q) => (/^https?:\/\//i.test(q) ? q : `https://${q}`),
  },
};

// Prefix → route. "route:mode" in Lifeboard set Claude Code's mode; Claude Code is not wired here,
// so !code / !plan / !fix fall back to Claude.
const PREFIXES: Record<string, RouteId> = {
  '!s': 'search',
  '!search': 'search',
  '!web': 'claude',
  '!ask': 'claude',
  '!gpt': 'chatgpt',
  '!g': 'gemini',
  '!deep': 'claude-deep',
  '!code': 'claude',
  '!plan': 'claude',
  '!fix': 'claude',
};

const URL_RE = /^(https?:\/\/\S+|(www\.)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?)$/i;
const CODE_RE = new RegExp(
  [
    '```',
    '^\\s+at \\S+ \\(',
    'Traceback \\(most recent call last\\)',
    'error\\[E\\d{4}\\]',
    '\\b[\\w-]+\\.(tsx?|jsx?|mjs|rs|py|go|css|scss|html|vue|svelte|toml|ya?ml)\\b',
    '(^|\\s)(\\.{1,2}|~)?\\/[\\w.-]+\\/[\\w./-]*',
  ].join('|'),
  'im'
);
const QWORD_RE = /^(who|what|when|where|why|how|which|is|are|can|does|do|should|explain|compare)\b/i;

function buildDecision(route: RouteId, text: string, why: string): RouteDecision {
  const r = ROUTES[route];
  return { route, label: r.label, cls: r.cls, url: r.url(text), text, why, copy: r.copy, hint: r.hint };
}

export function decide(input: string): RouteDecision | null {
  const raw = input.trim();
  if (!raw) return null;

  // 1. Prefix forces a route.
  const pre = raw.match(/^(![\w-]+)(\s+|$)/);
  if (pre) {
    const target = PREFIXES[pre[1].toLowerCase()];
    if (target) return buildDecision(target, raw.slice(pre[0].length).trim(), `prefix ${pre[1]}`);
  }

  const words = raw.match(/\S+/g) || [];

  // 2. Rules, highest priority first.
  if (!/\s/.test(raw) && URL_RE.test(raw)) return buildDecision('open-url', raw, 'looks like a web address');
  if (CODE_RE.test(raw)) return buildDecision('claude', raw, 'contains code, a file path or an error trace');
  if (words.length <= 3 && !QWORD_RE.test(raw) && !/\?\s*$/.test(raw)) {
    return buildDecision('search', raw, 'short lookup');
  }
  if (QWORD_RE.test(raw) || /\?\s*$/.test(raw)) return buildDecision('claude', raw, 'a question');

  // 3. Fallback (Lifeboard's default class is search).
  return buildDecision('search', raw, 'nothing matched, using the fallback');
}

/* ---------- Unit calculator (core/calc.js), returns a hint string or null ---------- */

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)';
const num = (s: string) => parseFloat(s.replace(/,/g, ''));

const SIZE: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
const SIZE_NAME: Record<string, string> = { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', kib: 'KiB', mib: 'MiB', gib: 'GiB', tib: 'TiB' };
const TWIN: Record<string, string> = { kb: 'kib', mb: 'mib', gb: 'gib', tb: 'tib', kib: 'kb', mib: 'mb', gib: 'gb', tib: 'tb' };
const MASS: Record<string, number> = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 };
const SIZE_RE = '(tib|gib|mib|kib|tb|gb|mb|kb|b)(?:ytes?)?';
const MASS_RE = '(kilograms?|kilos?|kgs?|grams?|g|pounds?|lbs?|ounces?|oz)';
const massUnit = (s: string) => (/^k/.test(s) ? 'kg' : /^g/.test(s) ? 'g' : /^(p|lb)/.test(s) ? 'lb' : 'oz');

const fmt = (n: number, d = 2) => String(Number(n.toFixed(d)));
const hours = (h: number) => (h < 1 ? `${fmt(h * 60, 0)} min` : `${fmt(h, 1)} h`);

function bitsPerSec(n: number, unit: string) {
  const u = unit.replace(/\s/g, '');
  const k = u[0] === 'g' ? 1e9 : u[0] === 'k' ? 1e3 : 1e6;
  return /^[kmg]b\/s$/.test(u) ? n * k * 8 : n * k;
}

const RE = {
  size: new RegExp(`^${NUM}\\s*${SIZE_RE}\\s*(?:to|in|as|->|=)\\s*${SIZE_RE}\\s*\\??$`),
  mass: new RegExp(`^${NUM}\\s*${MASS_RE}\\s*(?:to|in|as|->|=)\\s*${MASS_RE}\\s*\\??$`),
  mah: new RegExp(`^${NUM}\\s*mah(?:\\s*(?:at|@)\\s*${NUM}\\s*v)?(?:\\s*(?:to|in)\\s*wh)?\\s*\\??$`),
  rec: new RegExp(`${NUM}\\s*${SIZE_RE}\\s*(?:at|@)\\s*${NUM}\\s*(gbps|mbps|kbps|gbit/s|mbit/s|kbit/s|gb/s|mb/s|kb/s)`),
  xt4: /\bx-?t4\b/,
  anySize: new RegExp(`${NUM}\\s*(tb|gb)\\b`),
};

export function unitCalc(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (!t || t.length > 200 || !/\d/.test(t)) return null;

  let m = t.match(RE.size);
  if (m) {
    const unit = m[3];
    const bytes = num(m[1]) * SIZE[m[2]];
    const main = `${fmt(bytes / SIZE[unit])} ${SIZE_NAME[unit]}`;
    const twin = TWIN[unit];
    return twin ? `= ${main} · ${fmt(bytes / SIZE[twin])} ${SIZE_NAME[twin]}` : `= ${main}`;
  }

  m = t.match(RE.mass);
  if (m) {
    const to = massUnit(m[3]);
    const v = (num(m[1]) * MASS[massUnit(m[2])]) / MASS[to];
    return `= ${fmt(v, to === 'g' && v >= 10 ? 0 : 2)} ${to}`;
  }

  m = t.match(RE.mah);
  if (m) {
    const volts = m[2] ? num(m[2]) : 3.7;
    return `≈ ${fmt((num(m[1]) * volts) / 1000, 1)} Wh at ${fmt(volts, 2)} V`;
  }

  m = t.match(RE.rec);
  if (m) {
    const bits = num(m[1]) * SIZE[m[2]] * 8;
    return `= ${hours(bits / bitsPerSec(num(m[3]), m[4]) / 3600)}`;
  }

  if (RE.xt4.test(t)) {
    m = t.match(RE.anySize);
    if (!m) return null;
    const bits = num(m[1]) * SIZE[m[2]] * 8;
    return 'X-T4: ' + [400, 200, 100].map((r) => `${r} Mbps ≈ ${hours(bits / (r * 1e6) / 3600)}`).join(' · ');
  }
  return null;
}

/* ---------- Dashboard routing: adds Claude Code (!code/!plan/!fix), classifier + laya hooks ---------- */

export type DashCls = RouteCls | 'code';
export type DashSource = 'prefix' | 'rule' | 'classifier' | 'fallback' | 'laya' | 'pick';
export type CodeMode = 'plan' | 'direct';

export interface DashDecision {
  route: RouteId | 'code';
  label: string;
  cls: DashCls;
  url: string;
  text: string;
  why: string;
  source: DashSource;
  confidence: number;
  copy?: boolean;
  hint?: string;
  mode?: CodeMode;
  /** For route 'code': ready-to-paste `claude` terminal command. */
  command?: string;
}

const BIG = /\b(from scratch|new (app|project|feature|page|system|tool|extension)|build|implement|design|architect|refactor|migrate|rewrite|set ?up|add (a |an |the )?(feature|page|system|support|screen))\b/i;
const SMALL = /\b(typo|rename|bump|tweak|one[- ]line|quick fix|small|fix (the |this |a |that )?(typo|bug|error|test|lint|warning))\b/i;

export function codeMode(text: string): CodeMode {
  const n = (text.match(/\S+/g) || []).length;
  return SMALL.test(text) && !BIG.test(text) && n <= 25 ? 'direct' : 'plan';
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function claudeCommand(text: string, mode: CodeMode): string {
  return `claude${mode === 'plan' ? ' --permission-mode plan' : ''} ${shq(text)}`;
}

const CODE_PREFIX: Record<string, CodeMode | undefined> = { '!code': undefined, '!plan': 'plan', '!fix': 'direct' };

export function codeDecision(text: string, why: string, source: DashSource, mode?: CodeMode): DashDecision {
  const m = mode ?? codeMode(text);
  return {
    route: 'code',
    label: m === 'plan' ? 'Claude Code · plan' : 'Claude Code · direct',
    cls: 'code',
    url: '',
    text,
    why,
    source,
    confidence: 1,
    mode: m,
    command: claudeCommand(text, m),
    hint: 'Command copied. Paste it in a terminal in your project folder.',
  };
}

/** Force a specific route (used by the Tab picker). */
export function forceRoute(route: RouteId | 'code', text: string): DashDecision | null {
  const t = text.trim();
  if (!t) return null;
  if (route === 'code') return codeDecision(t, 'you picked it', 'pick');
  return { ...buildDecision(route, t, 'you picked it'), source: 'pick', confidence: 1 };
}

export const PICKABLE: Array<RouteId | 'code'> = ['search', 'claude', 'claude-deep', 'chatgpt', 'gemini', 'code'];
export const routeLabel = (r: RouteId | 'code') => (r === 'code' ? 'Claude Code' : ROUTES[r].label);

/** Prefix list for the hint row. */
export const DASH_PREFIXES = ['!s', '!ask', '!gpt', '!g', '!deep', '!code', '!plan', '!fix'];

export type ClassifierFn = (text: string) => { cls: string; p: number } | null;

/**
 * Like decide(), but Claude Code prefixes become a terminal route, code-ish text goes to Claude Code,
 * and when no rule matched the (optional) linear classifier gets a say before the fallback.
 */
export function decideDash(input: string, clf?: ClassifierFn | null): DashDecision | null {
  const raw = input.trim();
  if (!raw) return null;

  const pre = raw.match(/^(![\w-]+)(\s+|$)/);
  if (pre) {
    const key = pre[1].toLowerCase();
    if (key in CODE_PREFIX) return codeDecision(raw.slice(pre[0].length).trim(), `prefix ${pre[1]}`, 'prefix', CODE_PREFIX[key]);
  }

  const d = decide(raw);
  if (!d) return null;
  if (pre && PREFIXES[pre[1].toLowerCase()]) return { ...d, source: 'prefix', confidence: 1 };

  if (d.why === 'contains code, a file path or an error trace') return codeDecision(raw, d.why, 'rule');

  if (d.why.startsWith('nothing matched')) {
    const c = clf?.(raw);
    if (c && c.p >= 0.5) {
      const why = `classifier, ${Math.round(c.p * 100)}% sure`;
      if (c.cls === 'code') return { ...codeDecision(raw, why, 'classifier'), confidence: c.p };
      const route: RouteId = c.cls === 'ask' ? 'claude' : c.cls === 'deep' ? 'claude-deep' : 'search';
      return { ...buildDecision(route, raw, why), source: 'classifier', confidence: c.p };
    }
    return { ...d, source: 'fallback', confidence: 0 };
  }
  return { ...d, source: 'rule', confidence: 1 };
}

/** Apply a laya p_ai score: AI chat at >= aiAt, Google below. Never overrides prefix/pick/code. */
export function applyLaya(d: DashDecision, pAi: number, aiAt = 0.5): DashDecision {
  const ai = pAi >= aiAt;
  const why = `laya: ${Math.round(pAi * 100)}% AI`;
  const base = buildDecision(ai ? 'claude' : 'search', d.text, why);
  return { ...base, source: 'laya', confidence: ai ? pAi : 1 - pAi };
}

export const needsLaya = (d: DashDecision | null) =>
  !!d && d.cls !== 'code' && d.cls !== 'url' && (d.source === 'fallback' || (d.source === 'classifier' && d.confidence < 0.95));
