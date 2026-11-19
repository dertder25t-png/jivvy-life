// Port of Lifeboard core/classifier.js (scoring) and tools/train.py (training).
// Word and 3-letter features scored by a linear softmax model. Pure TS, no I/O.
import bundledWeights from './weights.json' with { type: 'json' };
import seedData from './seed.json' with { type: 'json' };

export type Cls = 'search' | 'ask' | 'deep' | 'code';
export const CLASSES: Cls[] = ['search', 'ask', 'deep', 'code'];

export interface ClassifierModel {
  version: number;
  classes: string[];
  bias: Record<string, number>;
  w: Record<string, Record<string, number>>;
}

export interface Labeled {
  text: string;
  cls: Cls;
}

export const BUNDLED_MODEL = bundledWeights as unknown as ClassifierModel;
export const SEED_EXAMPLES = seedData as Labeled[];

/** True if `x` looks like a model in weights.json format. */
export function isModel(x: unknown): x is ClassifierModel {
  const m = x as ClassifierModel | null;
  return !!m && Array.isArray(m.classes) && m.classes.length > 0 && typeof m.w === 'object' && m.w !== null && typeof m.bias === 'object';
}

// Must match features() in train.py and the original classifier.js exactly.
export function features(text: string): Set<string> {
  const t = text.toLowerCase().trim();
  const words = t.match(/[a-z0-9_']+/g) || [];
  const f = new Set<string>();
  for (const w of words) f.add('w:' + w);
  const s = ' ' + words.join(' ') + ' ';
  for (let i = 0; i + 3 <= s.length; i++) f.add('c:' + s.slice(i, i + 3));
  const n = words.length;
  f.add(n <= 3 ? 'len:s' : n <= 12 ? 'len:m' : 'len:l');
  if (/\?\s*$/.test(t)) f.add('end:?');
  if (/[{};=<>]|=>|\(\)/.test(t)) f.add('sym:code');
  if (n) f.add('f:' + words[0]);
  return f;
}

export function classify(model: ClassifierModel, text: string): { cls: string; p: number; probs: Record<string, number> } {
  const scores: Record<string, number> = {};
  for (const c of model.classes) scores[c] = model.bias[c] || 0;
  for (const feat of features(text)) {
    const w = model.w[feat];
    if (!w) continue;
    for (const c in w) scores[c] += w[c];
  }
  const max = Math.max(...Object.values(scores));
  let sum = 0;
  const probs: Record<string, number> = {};
  for (const c of model.classes) sum += probs[c] = Math.exp(scores[c] - max);
  let best = model.classes[0];
  for (const c of model.classes) {
    probs[c] /= sum;
    if (probs[c] > probs[best]) best = c;
  }
  return { cls: best, p: probs[best], probs };
}

// Small deterministic PRNG (the Python original used random.Random(0); the shuffle order differs, the method is the same).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Retrains the classifier: multinomial logistic regression, SGD, 40 epochs, lr 0.2, l2 1e-4.
 * Seed examples count once, corrections three times (as in tools/train.py).
 * Output is pruned (|w| >= 0.02) and rounded to 3 decimals, same as weights.json.
 */
export function trainClassifier(corrections: Labeled[] = [], seed: Labeled[] = SEED_EXAMPLES, epochs = 40, lr = 0.2, l2 = 1e-4): ClassifierModel {
  const data: { feats: string[]; label: Cls }[] = [];
  const push = (list: Labeled[], times: number) => {
    for (const ex of list) {
      if (!ex || !ex.text || !CLASSES.includes(ex.cls)) continue;
      const feats = [...features(ex.text)];
      for (let i = 0; i < times; i++) data.push({ feats, label: ex.cls });
    }
  };
  push(seed, 1);
  push(corrections, 3);

  const w = new Map<string, Float64Array>();
  const b = new Float64Array(CLASSES.length);
  const rnd = mulberry32(0);
  const scores = new Float64Array(CLASSES.length);
  const exp = new Float64Array(CLASSES.length);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = data.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = data[i];
      data[i] = data[j];
      data[j] = tmp;
    }
    for (const { feats, label } of data) {
      for (let c = 0; c < CLASSES.length; c++) scores[c] = b[c];
      for (const f of feats) {
        const row = w.get(f);
        if (row) for (let c = 0; c < CLASSES.length; c++) scores[c] += row[c];
      }
      let m = -Infinity;
      for (let c = 0; c < CLASSES.length; c++) if (scores[c] > m) m = scores[c];
      let z = 0;
      for (let c = 0; c < CLASSES.length; c++) z += exp[c] = Math.exp(scores[c] - m);
      const li = CLASSES.indexOf(label);
      for (let c = 0; c < CLASSES.length; c++) {
        const g = exp[c] / z - (c === li ? 1 : 0);
        b[c] -= lr * g;
        for (const f of feats) {
          let row = w.get(f);
          if (!row) w.set(f, (row = new Float64Array(CLASSES.length)));
          row[c] -= lr * (g + l2 * row[c]);
        }
      }
    }
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const pruned: ClassifierModel['w'] = {};
  for (const [f, row] of w) {
    const out: Record<string, number> = {};
    for (let c = 0; c < CLASSES.length; c++) if (Math.abs(row[c]) >= 0.02) out[CLASSES[c]] = r3(row[c]);
    if (Object.keys(out).length) pruned[f] = out;
  }
  const bias: Record<string, number> = {};
  CLASSES.forEach((c, i) => (bias[c] = r3(b[i])));
  return { version: 1, classes: [...CLASSES], bias, w: pruned };
}
