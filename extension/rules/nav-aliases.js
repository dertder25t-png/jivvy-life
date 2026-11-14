// "nav_shortcut_interceptor": typing a site name you usually search for (cfg.navAliases,
// learned by helper/pattern_miner.py or set on the Options page) opens the site itself.
// Exact match, or up to 2 letters off when the text is over 5 letters. Just below "web address".
import { registerRule } from "../core/registry.js";
import { matchAlias } from "../core/moves.js";

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

registerRule({
  id: "nav alias",
  priority: 95,
  test(t, ctx) {
    const aliases = ctx.cfg?.navAliases;
    if (!aliases || t.length > 60 || t.includes("\n")) return null;
    const hit = matchAlias(t, aliases);
    if (!hit) return null;
    return { route: "open-url", text: hit.url, label: hostOf(hit.url), why: "you usually go here" };
  },
});
