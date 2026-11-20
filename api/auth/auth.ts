import { api, APIError, Gateway, Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { getAuthData } from "~encore/auth";
import { randomUUID } from "node:crypto";
import { secret } from "encore.dev/config";
import { isValidBoundedString, isValidRedirectUri, checkGoogleClaims } from "./google_verify";
import { db } from "./db";
import { hashPassword, verifyPassword, newToken, hashToken } from "./crypto";

const googleClientId = secret("GoogleClientId");
const googleClientSecret = secret("GoogleClientSecret");

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
    const row = await db.queryRow<{ id: string; password_hash: string | null }>`
      SELECT id, password_hash FROM users WHERE email = ${email}`;
    // Hash even for unknown users to keep timing similar.
    const ok = await verifyPassword(
      req.password.slice(0, 256),
      row?.password_hash || "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==",
    );
    if (!row || !row.password_hash || !ok) {
      const list = recentFails(email);
      list.push(Date.now());
      fails.set(email, list);
      throw invalid();
    }
    fails.delete(email);
    return { token: await createSession(row.id), userId: row.id, email };
  },
);

interface GoogleRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

// No local rate limit here on purpose: there is no email to key on before the exchange, and
// one shared bucket would let a single abuser lock everyone out. Codes are single-use,
// unguessable, PKCE-bound and checked by Google, which rate-limits the token endpoint itself.
export const googleSignIn = api(
  { method: "POST", path: "/auth/google", expose: true },
  async (req: GoogleRequest): Promise<AuthResponse> => {
    if (!isValidBoundedString(req?.code, 2048)) throw APIError.invalidArgument("invalid code");
    if (!isValidBoundedString(req.codeVerifier, 256)) throw APIError.invalidArgument("invalid codeVerifier");
    if (!isValidRedirectUri(req.redirectUri)) throw APIError.invalidArgument("invalid redirectUri");

    const failed = () => APIError.unauthenticated("google sign-in failed");

    const clientId = googleClientId();
    let claims: Record<string, unknown>;
    try {
      const tokRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: req.code,
          client_id: clientId,
          client_secret: googleClientSecret(),
          redirect_uri: req.redirectUri,
          grant_type: "authorization_code",
          code_verifier: req.codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokRes.ok) throw failed();
      const tok = (await tokRes.json()) as { id_token?: unknown };
      if (typeof tok.id_token !== "string" || !tok.id_token) throw failed();
      const infoRes = await fetch(
        "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(tok.id_token),
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!infoRes.ok) throw failed();
      claims = (await infoRes.json()) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof APIError) throw e;
      throw failed();
    }
    if (checkGoogleClaims(claims, clientId) !== null) throw failed();

    const sub = claims.sub as string;
    const email = normalizeEmail(claims.email);

    let row = await db.queryRow<{ id: string; email: string }>`
      SELECT id, email FROM users WHERE google_sub = ${sub}`;
    if (!row) {
      const byEmail = await db.queryRow<{ id: string; email: string; google_sub: string | null }>`
        SELECT id, email, google_sub FROM users WHERE email = ${email}`;
      if (byEmail) {
        if (byEmail.google_sub && byEmail.google_sub !== sub) throw failed();
        await db.exec`UPDATE users SET google_sub = ${sub} WHERE id = ${byEmail.id}`;
        row = { id: byEmail.id, email: byEmail.email };
      } else {
        const id = randomUUID();
        const ins = await db.queryRow<{ id: string }>`
          INSERT INTO users (id, email, password_hash, google_sub) VALUES (${id}, ${email}, NULL, ${sub})
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!ins) throw failed(); // lost a race; client can simply retry
        row = { id, email };
      }
    }
    return { token: await createSession(row.id), userId: row.id, email: row.email };
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
