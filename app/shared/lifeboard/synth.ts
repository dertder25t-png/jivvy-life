// Deterministic synthetic browsing history for the search benchmark and tests: ~40 sites with Zipf popularity,
// daily habits by hour, a typed-vs-link mix, searches that end in a click, sites that start trending and ones
// that fade out. Same seed + now => identical output.
import type { TypedInput, Visit } from '../history-types.ts';

const DAY = 86400000;

// [host, title, alias typed in the search box ('' = none), preferred hour (-1 = any), typed probability, path variants]
const SITES: [string, string, string, number, number, string[]][] = [
  ['mail.google.com', 'Inbox - Gmail', 'gmail', 9, 0.7, ['/mail/u/0/#inbox']],
  ['pcci.instructure.com', 'Dashboard - Canvas', 'canvas', 10, 0.5, ['/', '/courses/101', '/courses/204/assignments']],
  ['github.com', 'GitHub', '', 14, 0.4, ['/', '/notifications', '/pulls']],
  ['youtube.com', 'YouTube', '', 21, 0.35, ['/', '/feed/subscriptions']],
  ['docs.google.com', 'Google Docs', 'docs', 11, 0.5, ['/document/u/0/', '/document/d/1abc/edit']],
  ['drive.google.com', 'My Drive - Google Drive', 'drive', 11, 0.55, ['/drive/my-drive']],
  ['calendar.google.com', 'Calendar', 'calendar', 8, 0.6, ['/calendar/u/0/r']],
  ['claude.ai', 'Claude', 'claude', -1, 0.6, ['/new', '/chats']],
  ['chatgpt.com', 'ChatGPT', 'chatgpt', -1, 0.5, ['/']],
  ['reddit.com', 'Reddit - Dive into anything', '', 22, 0.3, ['/', '/r/programming', '/r/linux']],
  ['news.ycombinator.com', 'Hacker News', 'hn', 8, 0.45, ['/', '/news?p=2']],
  ['stackoverflow.com', 'Stack Overflow', '', 15, 0.1, ['/questions/1', '/questions/2']],
  ['developer.mozilla.org', 'MDN Web Docs', 'mdn', 15, 0.15, ['/en-US/docs/Web/API']],
  ['wikipedia.org', 'Wikipedia', 'wiki', -1, 0.2, ['/wiki/Main_Page', '/wiki/Linux']],
  ['amazon.com', 'Amazon.com', 'amazon', 19, 0.4, ['/', '/gp/cart/view.html']],
  ['netflix.com', 'Netflix', 'netflix', 21, 0.5, ['/browse']],
  ['spotify.com', 'Spotify', '', 16, 0.3, ['/']],
  ['discord.com', 'Discord', 'discord', 20, 0.55, ['/channels/@me']],
  ['twitter.com', 'Home / X', '', 12, 0.25, ['/home']],
  ['linkedin.com', 'LinkedIn', '', 13, 0.3, ['/feed/']],
  ['figma.com', 'Figma', 'figma', 13, 0.35, ['/files/recent']],
  ['notion.so', 'Notion', 'notion', 10, 0.5, ['/workspace']],
  ['vercel.com', 'Vercel Dashboard', 'vercel', 14, 0.45, ['/dashboard']],
  ['dash.cloudflare.com', 'Cloudflare Dashboard', 'cloudflare', 14, 0.4, ['/']],
  ['console.firebase.google.com', 'Firebase console', '', 14, 0.3, ['/u/0/']],
  ['maps.google.com', 'Google Maps', 'maps', -1, 0.4, ['/']],
  ['weather.com', 'Weather', 'weather', 7, 0.35, ['/weather/today']],
  ['espn.com', 'ESPN', 'espn', 18, 0.3, ['/']],
  ['twitch.tv', 'Twitch', 'twitch', 20, 0.35, ['/directory']],
  ['bankofamerica.com', 'Bank of America', 'bank', 17, 0.5, ['/']],
  ['paypal.com', 'PayPal', '', 17, 0.3, ['/myaccount/summary']],
  ['zoom.us', 'Zoom', 'zoom', 9, 0.4, ['/myhome']],
  ['slack.com', 'Slack', 'slack', 9, 0.4, ['/client']],
  ['pinterest.com', 'Pinterest', 'pinterest', 20, 0.3, ['/']],
  ['medium.com', 'Medium', '', 12, 0.1, ['/', '/tag/ai']],
  ['npmjs.com', 'npm', '', 15, 0.15, ['/package/react']],
  ['coursera.org', 'Coursera', 'coursera', 19, 0.3, ['/learn/ml']],
  ['duolingo.com', 'Duolingo', 'duolingo', 18, 0.45, ['/learn']],
  ['kayak.com', 'Kayak', '', 20, 0.2, ['/flights']],
  ['craigslist.org', 'craigslist', '', 12, 0.2, ['/']],
  ['target.com', 'Target', '', 18, 0.2, ['/']],
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Synth {
  visits: Visit[];
  typed: TypedInput[];
  now: number;
}

export function synthHistory(seed = 7, now = new Date(2026, 10, 18, 14, 30).getTime(), days = 60): Synth {
  const rand = rng(seed);
  // popularity order is shuffled so alphabetical/list order carries no signal
  const order = SITES.map((_, i) => i).sort(() => rand() - 0.5);
  const weight = new Map<number, number>();
  order.forEach((si, rank) => weight.set(si, 1 / Math.pow(rank + 1, 0.9)));
  // dynamics: 4 sites start trending 20 days ago, 3 popular ones were dropped ~25 days ago
  const trending = new Set(order.slice(14, 18));
  const faded = new Set(order.slice(1, 4));
  const visits: Visit[] = [];
  const typed: TypedInput[] = [];
  const mk = (host: string, path: string, title: string, t: number, transition: Visit['transition'], extra: Partial<Visit> = {}): Visit => ({
    url: `https://${host}${path}`, host, path: path.split('#')[0], title, t, transition, ...extra,
  });

  for (let d = days; d >= 1; d--) {
    const day0 = new Date(now - d * DAY);
    day0.setHours(0, 0, 0, 0);
    const weekend = day0.getDay() === 0 || day0.getDay() === 6;
    const sessions = Math.round((weekend ? 30 : 48) * (0.7 + rand() * 0.6));
    for (let s = 0; s < sessions; s++) {
      const hour = Math.min(23, Math.max(6, Math.round(7 + rand() * 9 + rand() * 6)));
      const t0 = day0.getTime() + hour * 3600000 + Math.floor(rand() * 3600000);
      if (t0 >= now) continue;
      // pick a site by popularity x habit affinity for this hour x trend
      let tot = 0;
      const w = SITES.map((site, i) => {
        let x = weight.get(i)!;
        const ph = site[3];
        if (ph >= 0) x *= 0.25 + 1.75 * Math.exp(-Math.pow((hour - ph) / 2.2, 2));
        if (trending.has(i)) x *= d <= 20 ? 3.2 : 0.05;
        if (faded.has(i)) x *= d > 25 ? 1.5 : 0.1;
        tot += x;
        return x;
      });
      let r = rand() * tot, pick = 0;
      for (let i = 0; i < w.length; i++) {
        r -= w[i];
        if (r <= 0) { pick = i; break; }
      }
      const [host, title, alias, , typedP, paths] = SITES[pick];
      let t = t0;
      const viaSearch = alias !== '' && rand() < 0.18;
      if (viaSearch) {
        const q = alias;
        visits.push(mk('google.com', '/search?q=' + encodeURIComponent(q), q + ' - Google Search', t, 'typed', { query: q, engine: 'google' }));
        t += 4000 + Math.floor(rand() * 20000);
        visits.push(mk(host, paths[0], title, t, 'search'));
      } else if (rand() < typedP) {
        visits.push(mk(host, paths[0], title, t, 'typed'));
        if (rand() < 0.25) {
          const text = alias && rand() < 0.85 ? alias : host.split('.')[0].slice(0, 2 + Math.floor(rand() * 3));
          typed.push({ text, url: `https://${host}${paths[0]}`, shownUrl: `https://${host}${paths[0]}`, accepted: rand() < 0.6, t: t - 1500 });
        }
      } else {
        visits.push(mk(host, paths[0], title, t, rand() < 0.1 ? 'other' : 'link'));
      }
      const more = Math.floor(rand() * 3);
      for (let k = 0; k < more; k++) {
        t += 20000 + Math.floor(rand() * 240000);
        const p = paths[Math.floor(rand() * paths.length)];
        visits.push(mk(host, p, title, t, rand() < 0.1 ? 'reload' : 'link'));
      }
    }
  }
  visits.sort((a, b) => a.t - b.t);
  typed.sort((a, b) => a.t - b.t);
  return { visits, typed, now };
}
