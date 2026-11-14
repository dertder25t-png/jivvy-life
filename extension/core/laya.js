// Asks the local laya service (helper/laya_server.py): Google or AI?
// Runs on Enter only when the built-in classifier is unsure (or nothing matched), and gives up
// after cfg.laya.timeoutMs so a stopped service never blocks you: the old answer is used.
// Measured on 110 searches (30 samples + 80 of your own held out): 107 right with your history added.

export function lacksCertainty(d, cfg) {
  if (!d || d.pending) return false;
  return d.source === "fallback" || (d.source === "classifier" && d.confidence < (cfg.laya?.classifierTrust ?? 0.95));
}

export async function askLaya(text, cfg, fetchImpl = globalThis.fetch) {
  const opt = cfg.laya || {};
  if (!opt.enabled || !opt.url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs ?? 2500);
  try {
    const res = await fetchImpl(opt.url.replace(/\/$/, "") + "/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    const out = await res.json();
    return out && out.ok && typeof out.p_ai === "number" ? out : null;
  } catch {
    return null; // service off, still loading, or too slow
  } finally {
    clearTimeout(timer);
  }
}

// Turns laya's answer into a router hit: AI chat at or above cfg.laya.aiAt, Google below it.
export function layaHit(out, cfg) {
  if (!out) return null;
  const ai = out.p_ai >= (cfg.laya?.aiAt ?? 0.5);
  const cls = ai ? "ask" : "search";
  return { cls, why: `laya: ${Math.round(out.p_ai * 100)}% AI (${Math.round(out.ms ?? 0)} ms)`, source: "laya", confidence: ai ? out.p_ai : 1 - out.p_ai };
}
