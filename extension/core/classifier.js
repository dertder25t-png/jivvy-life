// A tiny text classifier: word and 3-letter features scored by a linear model.
// About a hundred lookups per request, well under a millisecond, no GPU, no network.
// tools/train.py builds model/weights.json; its features() must match this one exactly.

export function features(text) {
  const t = text.toLowerCase().trim();
  const words = t.match(/[a-z0-9_']+/g) || [];
  const f = new Set();
  for (const w of words) f.add("w:" + w);
  const s = " " + words.join(" ") + " ";
  for (let i = 0; i + 3 <= s.length; i++) f.add("c:" + s.slice(i, i + 3));
  const n = words.length;
  f.add(n <= 3 ? "len:s" : n <= 12 ? "len:m" : "len:l");
  if (/\?\s*$/.test(t)) f.add("end:?");
  if (/[{};=<>]|=>|\(\)/.test(t)) f.add("sym:code");
  if (n) f.add("f:" + words[0]);
  return f;
}

export function classify(model, text) {
  const scores = {};
  for (const c of model.classes) scores[c] = model.bias[c] || 0;
  for (const feat of features(text)) {
    const w = model.w[feat];
    if (!w) continue;
    for (const c in w) scores[c] += w[c];
  }
  const max = Math.max(...Object.values(scores));
  let sum = 0;
  const probs = {};
  for (const c of model.classes) sum += probs[c] = Math.exp(scores[c] - max);
  let best = model.classes[0];
  for (const c of model.classes) {
    probs[c] /= sum;
    if (probs[c] > probs[best]) best = c;
  }
  return { cls: best, p: probs[best], probs };
}

export async function loadModel(url = new URL("../model/weights.json", import.meta.url)) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return null; // no model: rules and fallback still work
  }
}
