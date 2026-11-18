import { api, APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { getAuthData } from "~encore/auth";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { hashPassword, verifyPassword, newToken, hashToken } from "./crypto";

const SESSION_MS = 60 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Credentials {
  email: string;
  password: string;
}
interface AuthResponse {
  token: string;
  userId: string;
  email: string;
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") throw APIError.invalidArgument("invalid email");
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw APIError.invalidArgument("invalid email");
  return e;
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8) {
    throw APIError.invalidArgument("password must be at least 8 characters");
  }
  if (password.length > 256) throw APIError.invalidArgument("password too long");
  return password;
}

async function createSession(userId: string): Promise<string> {
  const token = newToken();
  await db.exec`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${new Date(Date.now() + SESSION_MS)})`;
  return token;
}

// Naive in-memory per-email login rate limit: 5 failures / 15 minutes.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map<string, number[]>();

function recentFails(email: string): number[] {
  const now = Date.now();
  const list = (fails.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(email, list);
  else fails.delete(email);
  return list;
}

export const signup = api(
  { method: "POST", path: "/auth/signup", expose: true },
  async (req: Credentials): Promise<AuthResponse> => {
    const email = normalizeEmail(req.email);
    const password = checkPassword(req.password);
    const id = randomUUID();
    const hash = await hashPassword(password);
    const inserted = await db.queryRow`
      INSERT INTO users (id, email, password_hash) VALUES (${id}, ${email}, ${hash})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (!inserted) throw APIError.alreadyExists("an account with this email already exists");
    return { token: await createSession(id), userId: id, email };
  },
);

export const login = api(
  { method: "POST", path: "/auth/login", expose: true },
  async (req: Credentials): Promise<AuthResponse> => {
    const invalid = () => APIError.unauthenticated("invalid email or password");
    if (typeof req.email !== "string" || typeof req.password !== "string") throw invalid();
    const email = req.email.trim().toLowerCase();
    if (recentFails(email).length >= MAX_FAILS) {
      throw APIError.resourceExhausted("too many attempts, try again later");
    }
    const row = await db.queryRow<{ id: string; password_hash: string }>`
      SELECT id, password_hash FROM users WHERE email = ${email}`;
    // Hash even for unknown users to keep timing similar.
    const ok = await verifyPassword(
      req.password.slice(0, 256),
      row?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==",
    );
    if (!row || !ok) {
      const list = recentFails(email);
      list.push(Date.now());
      fails.set(email, list);
      throw invalid();
    }
    fails.delete(email);
    return { token: await createSession(row.id), userId: row.id, email };
  },
);

export interface AuthParams {
  authorization: Header<"Authorization">;
}
export interface AuthData {
  userID: string;
  email: string;
  tokenHash: string;
}

export const auth = authHandler(async (params: AuthParams): Promise<AuthData> => {
  const m = /^Bearer\s+(\S+)$/i.exec(params.authorization ?? "");
  if (!m) throw APIError.unauthenticated("missing bearer token");
  const tokenHash = hashToken(m[1]);
  const row = await db.queryRow<{ user_id: string; email: string }>`
    SELECT s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()`;
  if (!row) throw APIError.unauthenticated("invalid or expired token");
  return { userID: row.user_id, email: row.email, tokenHash };
});

export const gateway = new Gateway({ authHandler: auth });

export const logout = api(
  { method: "POST", path: "/auth/logout", expose: true, auth: true },
  async (): Promise<{ ok: boolean }> => {
    const { tokenHash } = getAuthData()!;
    await db.exec`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
    return { ok: true };
  },
);

export const me = api(
  { method: "GET", path: "/auth/me", expose: true, auth: true },
  async (): Promise<{ userId: string; email: string }> => {
    const d = getAuthData()!;
    return { userId: d.userID, email: d.email };
  },
);
