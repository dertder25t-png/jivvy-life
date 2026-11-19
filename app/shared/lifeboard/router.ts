// Port of Lifeboard core/router.js + rules/basic.js + rules/nav-aliases.js + the route table in core/config.js.
// Order: bang prefix, then rules by priority, then the classifier, then the fallback.
// Not ported: the laya/NPU /decide refinement.
import type { PredictionSnapshot } from '../history-types.ts';
import { BUNDLED_MODEL, classify, isModel } from './classifier.ts';
import type { ClassifierModel } from './classifier.ts';
import { calc } from './calc.ts';
import { matchAlias } from './moves.ts';

export type RouteCls = 'search' | 'ask' | 'deep' | 'code';

export interface UrlRoute {
  id: string;
  label: string;
  cls: RouteCls;
  /** {q} = URL-encoded text, {raw} = text as typed. */
  template: string;
  copy?: boolean;
  hint?: string;
}

export interface UserRule {
  id?: string;
  pattern: string;
  flags?: string;
  cls?: RouteCls;
  route?: string;
  mode?: string;
  priority?: number;
}

export interface Project {
  name: string;
  path?: string;
}

export interface RouterConfig {
  prefixes: Record<string, string>; // "!s" -> "route" or "route:mode"
  classRoutes: Record<string, string>;
  fallbackClass: RouteCls;
  classifierThreshold: number;
  urlRoutes: UrlRoute[];
  rules: UserRule[];
  allProjects: Project[];
  /** Your own typed text -> address; they win over learned aliases from the snapshot. */
  navAliases: Record<string, string>;
}

export const DEFAULT_CONFIG: RouterConfig = {
  prefixes: {
    '!s': 'search',
    '!search': 'search',
    '!web': 'claude',
    '!ask': 'claude',
    '!gpt': 'chatgpt',
    '!g': 'gemini',
    '!deep': 'claude-deep',
    '!code': 'claude-code',
    '!plan': 'claude-code:plan',
    '!fix': 'claude-code:direct',
  },
  classRoutes: { search: 'search', ask: 'claude', deep: 'claude-deep', code: 'claude-code' },
  fallbackClass: 'search',
  classifierThreshold: 0.5,
  urlRoutes: [
    { id: 'search', label: 'Google', cls: 'search', template: 'https://www.google.com/search?q={q}' },
    { id: 'claude', label: 'Claude', cls: 'ask', template: 'https://claude.ai/new?q={q}' },
    { id: 'claude-deep', label: 'Claude Research', cls: 'deep', template: 'https://claude.ai/new?q={q}', hint: 'Turn on Research in the message box, then press send.' },
    { id: 'chatgpt', label: 'ChatGPT', cls: 'ask', template: 'https://chatgpt.com/?q={q}' },
    { id: 'gemini', label: 'Gemini', cls: 'ask', template: 'https://gemini.google.com/app', copy: true, hint: 'Your text is on the clipboard. Paste it into Gemini.' },
  ],
  rules: [],
  allProjects: [],
  navAliases: {},
};

/** Fills in defaults. Objects merge key by key, urlRoutes by id, your rules run before the default ones. */
export function mergeConfig(user: Partial<RouterConfig> = {}): RouterConfig {
  const byId = new Map(DEFAULT_CONFIG.urlRoutes.map((r) => [r.id, r]));
  for (const u of user.urlRoutes || []) byId.set(u.id, { ...(byId.get(u.id) || ({} as UrlRoute)), ...u });
  return {
    ...DEFAULT_CONFIG,
    ...user,
    prefixes: { ...DEFAULT_CONFIG.prefixes, ...(user.prefixes || {}) },
    classRoutes: { ...DEFAULT_CONFIG.classRoutes, ...(user.classRoutes || {}) },
    navAliases: { ...(user.navAliases || {}) },
    urlRoutes: [...byId.values()],
    rules: [...(user.rules || [])],
    allProjects: user.allProjects || [],
  };
}

export interface Decision {
  /** "search" | "claude" | "claude-deep" | "chatgpt" | "gemini" | "claude-code" | "open-url" | your own route id. */
  route: string;
  /** Where to navigate. Absent for claude-code (the caller launches the terminal flow with `text`). */
  url?: string;
  label: string;
  why: string;
  confidence: number; // 0..1
  // extras the UI may use
  cls?: RouteCls;
  mode?: string; // claude-code: "plan" | "direct"
  text: string; // what the route receives (the URL for open-url)
  raw: string; // what you typed
  project?: Project | null;
  source: 'prefix' | 'rule' | 'classifier' | 'fallback';
  copy?: boolean;
  hint?: string;
  /** Unit-math answer for the hint line ("157919MB to gb"), never changes the route. */
  calc?: string;
}

const ROUTE_CLS: Record<string, RouteCls> = { 'claude-code': 'code' };

const BIG = /\b(from scratch|new (app|project|feature|page|system|tool|extension)|build|implement|design|architect|refactor|migrate|rewrite|set ?up|add (a |an |the )?(feature|page|system|support|screen))\b/i;
const SMALL = /\b(typo|rename|bump|tweak|one[- ]line|quick fix|small|fix (the |this |a |that )?(typo|bug|error|test|lint|warning))\b/i;

/** Plan mode for big or vague jobs, direct for small fixes. When unsure: plan. */
export function codeMode(text: string): 'plan' | 'direct' {
  const n = (text.match(/\S+/g) || []).length;
  if (SMALL.test(text) && !BIG.test(text) && n <= 25) return 'direct';
  return 'plan';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findProject(text: string, projects: Project[] = []): Project | null {
  const lower = text.toLowerCase();
  for (const p of projects) {
    const re = new RegExp(`(^|[^a-z0-9_-])${escapeRe(p.name.toLowerCase())}($|[^a-z0-9_-])`);
    if (re.test(lower)) return p;
  }
  return null;
}

export function parsePrefix(text: string, cfg: Pick<RouterConfig, 'prefixes'>): { route: string; mode?: string; prefix: string; text: string } | null {
  const m = text.match(/^(![\w-]+)(\s+|$)/);
  if (!m) return null;
  const target = cfg.prefixes[m[1].toLowerCase()];
  if (!target) return null;
  const [route, mode] = target.split(':');
  return { route, mode, prefix: m[1], text: text.slice(m[0].length).trim() };
}

// ---- rules (priority order, highest first) ----
interface Ctx {
  cfg: RouterConfig;
  project: Project | null;
  words: string[];
  aliases: Record<string, string>;
}
interface Hit {
  cls?: RouteCls;
  route?: string;
  mode?: string;
  why?: string;
  text?: string;
  label?: string;
}
interface Rule {
  id: string;
  priority: number;
  test(t: string, ctx: Ctx): Hit | null;
}

const BUILD = /\b(build|make|add|implement|fix|refactor|debug|write|create|change|update|rename|remove|test|deploy|migrate|port)\b/i;
const TECH = /\b(code|function|component|api|bug|error|crash|compile|repo|branch|commit|typescript|javascript|rust|python|css|html|react|svelte|tauri|cargo|npm|extension)\b/i;
const QWORD = /^(who|what|when|where|why|how|which|is|are|can|does|do|should|explain|compare)\b/i;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const BUILTIN_RULES: Rule[] = [
  {
    id: 'web address',
    priority: 100,
    test(t) {
      if (/\s/.test(t)) return null;
      if (/^https?:\/\/\S+$/i.test(t) || /^(www\.)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t)) {
        return { route: 'open-url', why: 'looks like a web address' };
      }
      return null;
    },
  },
  {
    id: 'nav alias',
    priority: 95,
    test(t, ctx) {
      if (t.length > 60 || t.includes('\n')) return null;
      const hit = matchAlias(t, ctx.aliases);
      if (!hit) return null;
      return { route: 'open-url', text: hit.url, label: hostOf(hit.url), why: 'you usually go here' };
    },
  },
  {
    id: 'code or error text',
    priority: 90,
    test(t) {
      const codey =
        /```/.test(t) ||
        /^\s+at \S+ \(/m.test(t) ||
        /Traceback \(most recent call last\)/.test(t) ||
        /error\[E\d{4}\]/.test(t) ||
        /\b[\w-]+\.(tsx?|jsx?|mjs|rs|py|go|css|scss|html|vue|svelte|toml|ya?ml)\b/i.test(t) ||
        /(^|\s)(\.{1,2}|~)?\/[\w.-]+\/[\w.\/-]*/.test(t);
      return codey ? { cls: 'code', why: 'contains code, a file path or an error trace' } : null;
    },
  },
  {
    id: 'mentions a project',
    priority: 80,
    test(t, ctx) {
      if (ctx.project && (BUILD.test(t) || TECH.test(t))) return { cls: 'code', why: `mentions your project “${ctx.project.name}”` };
      return null;
    },
  },
  {
    id: 'short lookup',
    priority: 10,
    test(t, ctx) {
      if (ctx.words.length <= 3 && !QWORD.test(t) && !/\?\s*$/.test(t)) return { cls: 'search', why: 'short lookup' };
      return null;
    },
  },
];

function userRules(cfg: RouterConfig): Rule[] {
  const list: Rule[] = [];
  for (const r of cfg.rules || []) {
    try {
      const re = new RegExp(r.pattern, r.flags ?? 'i');
      list.push({
        id: r.id || r.pattern,
        priority: r.priority ?? 60,
        test: (t) => (re.test(t) ? { cls: r.cls, route: r.route, mode: r.mode, why: `your rule “${r.id || r.pattern}”` } : null),
      });
    } catch {
      /* skip a rule with a bad pattern */
    }
  }
  return list;
}

const labelOf = (cfg: RouterConfig, route: string): string => {
  if (route === 'claude-code') return 'Claude Code';
  if (route === 'open-url') return 'Open site';
  return cfg.urlRoutes.find((r) => r.id === route)?.label ?? route;
};

function normalizeAddress(text: string): string {
  return /^https?:\/\//i.test(text) ? text : 'https://' + text;
}

function finish(hit: Hit & { why: string; source: Decision['source']; confidence: number }, text: string, cfg: RouterConfig, project: Project | null, raw: string): Decision {
  const route = hit.route || cfg.classRoutes[hit.cls!] || 'search';
  const urlRoute = cfg.urlRoutes.find((r) => r.id === route);
  const cls = urlRoute?.cls ?? ROUTE_CLS[route] ?? hit.cls;
  const mode = cls === 'code' ? hit.mode || codeMode(text) : undefined;
  const outText = hit.text ?? text;
  const d: Decision = {
    route,
    label: hit.label ?? labelOf(cfg, route),
    why: hit.why,
    confidence: hit.confidence,
    cls,
    mode,
    text: outText,
    raw,
    project,
    source: hit.source,
  };
  if (route === 'open-url') d.url = normalizeAddress(outText);
  else if (urlRoute) {
    d.url = urlRoute.template.replaceAll('{q}', encodeURIComponent(outText)).replaceAll('{raw}', outText);
    if (urlRoute.copy) d.copy = true;
    if (urlRoute.hint) d.hint = urlRoute.hint;
  }
  const c = calc(raw);
  if (c) d.calc = c;
  return d;
}

/**
 * Decide where `input` goes. Returns null for empty input.
 * snapshot.aliases (merged under cfg.navAliases) feed the nav-alias rule;
 * snapshot.classifier (else the bundled weights) feeds the classifier.
 */
export function decide(input: string, cfg: RouterConfig = DEFAULT_CONFIG, snapshot?: Pick<PredictionSnapshot, 'aliases' | 'classifier'> | null): Decision | null {
  const raw = input.trim();
  if (!raw) return null;

  const pre = parsePrefix(raw, cfg);
  if (pre) {
    const project = findProject(pre.text, cfg.allProjects);
    return finish({ route: pre.route, mode: pre.mode, why: `prefix ${pre.prefix}`, source: 'prefix', confidence: 1 }, pre.text, cfg, project, raw);
  }

  const project = findProject(raw, cfg.allProjects);
  const ctx: Ctx = { cfg, project, words: raw.match(/\S+/g) || [], aliases: { ...(snapshot?.aliases || {}), ...(cfg.navAliases || {}) } };
  const all = [...userRules(cfg), ...BUILTIN_RULES].sort((a, b) => b.priority - a.priority);
  for (const r of all) {
    const hit = r.test(raw, ctx);
    if (hit) return finish({ why: r.id, ...hit, source: 'rule', confidence: 1 }, raw, cfg, project, raw);
  }

  const model: ClassifierModel = isModel(snapshot?.classifier) ? snapshot!.classifier : BUNDLED_MODEL;
  const { cls, p } = classify(model, raw);
  if (p >= cfg.classifierThreshold) {
    return finish({ cls: cls as RouteCls, why: `classifier, ${Math.round(p * 100)}% sure`, source: 'classifier', confidence: p }, raw, cfg, project, raw);
  }
  return finish({ cls: cfg.fallbackClass, why: 'nothing matched, using the fallback', source: 'fallback', confidence: 0 }, raw, cfg, project, raw);
}
