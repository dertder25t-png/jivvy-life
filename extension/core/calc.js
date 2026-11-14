// Answers small unit questions typed in the box, for the hint line. Never changes the route.
//   "157919MB to gb"  → "= 157.92 GB · 147.07 GiB"
//   "1.43 kg to lb"   → "= 3.15 lb"          "1.7 lb to grams" → "= 771 g"
//   "27000 mah"       → "≈ 99.9 Wh at 3.7 V"
//   "8tb at 400mbps"  → "= 44.4 h"
//   "how long can an xt4 record on 512gb" → hours at 400/200/100 Mbps
// Returns null for anything else (one cheap regex test for ordinary sentences).

const NUM = "(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)";
const num = (s) => parseFloat(s.replace(/,/g, ""));

// bytes per unit
const SIZE = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
const SIZE_NAME = { b: "B", kb: "KB", mb: "MB", gb: "GB", tb: "TB", kib: "KiB", mib: "MiB", gib: "GiB", tib: "TiB" };
const SIZE_RE = "(tib|gib|mib|kib|tb|gb|mb|kb|b)(?:ytes?)?";
// grams per unit
const MASS = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 };
const MASS_RE = "(kilograms?|kilos?|kgs?|grams?|g|pounds?|lbs?|ounces?|oz)";
const massUnit = (s) => (/^k/.test(s) ? "kg" : /^g/.test(s) ? "g" : /^(p|lb)/.test(s) ? "lb" : "oz");

// Rounds to `d` decimals and drops trailing zeros.
const fmt = (n, d = 2) => String(Number(n.toFixed(d)));
const hours = (h) => (h < 1 ? fmt(h * 60, 0) + " min" : fmt(h, 1) + " h");

// The binary twin of a decimal unit and back (GB ↔ GiB), for the second answer.
const TWIN = { kb: "kib", mb: "mib", gb: "gib", tb: "tib", kib: "kb", mib: "mb", gib: "gb", tib: "tb" };

function sizeTo(bytes, unit) {
  const main = `${fmt(bytes / SIZE[unit])} ${SIZE_NAME[unit]}`;
  const twin = TWIN[unit];
  return twin ? `= ${main} · ${fmt(bytes / SIZE[twin])} ${SIZE_NAME[twin]}` : `= ${main}`;
}

// rate in bits per second: "mbps"/"mbit/s" are megabits, "mb/s" megabytes.
function bitsPerSec(n, unit) {
  const u = unit.replace(/\s/g, "");
  const k = u[0] === "g" ? 1e9 : u[0] === "k" ? 1e3 : 1e6;
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

export function calc(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t || t.length > 200 || !/\d/.test(t)) return null;

  let m = t.match(RE.size);
  if (m) return sizeTo(num(m[1]) * SIZE[m[2]], m[3]);

  m = t.match(RE.mass);
  if (m) {
    const to = massUnit(m[3]);
    const v = (num(m[1]) * MASS[massUnit(m[2])]) / MASS[to];
    return `= ${fmt(v, to === "g" && v >= 10 ? 0 : 2)} ${to}`;
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
    return "X-T4: " + [400, 200, 100].map((r) => `${r} Mbps ≈ ${hours(bits / (r * 1e6) / 3600)}`).join(" · ");
  }
  return null;
}
