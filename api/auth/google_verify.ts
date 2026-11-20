// Pure helpers for Google sign-in (no encore imports so they can be unit tested).

export const LOOPBACK_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/;

export function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 64 || !LOOPBACK_REDIRECT_RE.test(uri)) return false;
  const port = Number(/:(\d+)\//.exec(uri)![1]);
  return port >= 1 && port <= 65535;
}

export function isValidBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

export interface GoogleClaims {
  aud?: unknown;
  iss?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
  sub?: unknown;
}

/** Returns null if claims are acceptable, else a short reason (for server logs only). */
export function checkGoogleClaims(
  c: GoogleClaims,
  clientId: string,
  nowMs: number = Date.now(),
): string | null {
  if (!c || typeof c !== "object") return "no claims";
  if (typeof c.aud !== "string" || c.aud !== clientId) return "bad aud";
  if (c.iss !== "accounts.google.com" && c.iss !== "https://accounts.google.com") return "bad iss";
  if (c.email_verified !== true && c.email_verified !== "true") return "email not verified";
  const exp = Number(c.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return "expired";
  if (typeof c.sub !== "string" || !c.sub) return "no sub";
  if (typeof c.email !== "string" || !c.email) return "no email";
  return null;
}
