// Tiny storage wrapper. Uses browser.storage.local inside Firefox and falls back to
// localStorage when the page is opened outside the extension (handy for previewing).
const ext = typeof browser !== "undefined" && browser.storage && browser.storage.local;

export async function get(key, fallback) {
  try {
    if (ext) {
      const r = await browser.storage.local.get(key);
      return r[key] ?? fallback;
    }
    const v = localStorage.getItem("hub:" + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export async function set(key, value) {
  try {
    if (ext) return await browser.storage.local.set({ [key]: value });
    localStorage.setItem("hub:" + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

// Append to a capped list (history, corrections).
export async function push(key, item, cap) {
  const list = await get(key, []);
  list.push(item);
  while (list.length > cap) list.shift();
  await set(key, list);
}

export const inExtension = !!ext;
