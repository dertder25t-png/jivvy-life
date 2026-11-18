import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { SQLDatabase } from "encore.dev/storage/sqldb";

const db = SQLDatabase.named("jivvy");

const MAX_ROWS = 500;
const MAX_ROW_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
// Inserts use (x::jsonb #>> '{}')::jsonb: the driver binds our JSON text as a jsonb *string*,
// so a plain ::jsonb stored double-encoded documents. Unwrapping stores the object either way.

// Arbitrary JSON document. Encore's codec stringifies `Record<string, unknown>`; `any` passes
// objects through as-is. checkData() still enforces "plain object, <= 1MB" on input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonDoc = any;

export interface Row {
  id: string;
  data: JsonDoc;
  updatedAt: string;
  deleted?: boolean;
}
interface TelemetryEvent {
  id: string;
  data: JsonDoc;
  createdAt: string;
}
interface PushRequest {
  workspaces?: Row[];
  notes?: Row[];
  preferences?: { data: JsonDoc; updatedAt: string };
  telemetry?: TelemetryEvent[];
}
interface PushResponse {
  accepted: { workspaces: string[]; notes: string[] };
  serverTime: string;
}
interface PullRequest {
  since?: Query<string>;
}
interface PullResponse {
  workspaces: Row[];
  notes: Row[];
  preferences: { data: JsonDoc; updatedAt: string } | null;
  serverTime: string;
}

function bad(msg: string): never {
  throw APIError.invalidArgument(msg);
}

function parseDate(v: unknown, what: string): Date {
  if (typeof v !== "string") bad(`${what} must be an ISO date string`);
  const d = new Date(v);
  if (isNaN(d.getTime())) bad(`${what} is not a valid date`);
  return d;
}

function checkData(data: unknown, what: string): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) bad(`${what}.data must be an object`);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_ROW_BYTES) bad(`${what} exceeds 1MB`);
  return json;
}

function checkRows(rows: Row[] | undefined, name: string) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) bad(`${name} must be an array`);
  if (rows.length > MAX_ROWS) bad(`${name}: max ${MAX_ROWS} rows per push`);
  return rows.map((r, i) => {
    const what = `${name}[${i}]`;
    if (typeof r?.id !== "string" || !ID_RE.test(r.id)) bad(`${what}.id is invalid`);
    return {
      id: r.id,
      json: checkData(r.data, what),
      updatedAt: parseDate(r.updatedAt, `${what}.updatedAt`),
      deleted: r.deleted === true,
    };
  });
}

async function upsertRows(userId: string, table: "workspaces" | "notes", rows: ReturnType<typeof checkRows>) {
  const accepted: string[] = [];
  for (const r of rows) {
    // Table name is from a fixed union, never user input.
    const q =
      table === "workspaces"
        ? db.queryRow`
            INSERT INTO workspaces (user_id, id, data, updated_at, deleted)
            VALUES (${userId}, ${r.id}, (${r.json}::jsonb #>> '{}')::jsonb, ${r.updatedAt}, ${r.deleted})
            ON CONFLICT (user_id, id) DO UPDATE
              SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, synced_at = now()
              WHERE EXCLUDED.updated_at > workspaces.updated_at
            RETURNING id`
        : db.queryRow`
            INSERT INTO notes (user_id, id, data, updated_at, deleted)
            VALUES (${userId}, ${r.id}, (${r.json}::jsonb #>> '{}')::jsonb, ${r.updatedAt}, ${r.deleted})
            ON CONFLICT (user_id, id) DO UPDATE
              SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, synced_at = now()
              WHERE EXCLUDED.updated_at > notes.updated_at
            RETURNING id`;
    if (await q) accepted.push(r.id);
  }
  return accepted;
}

export const push = api(
  { method: "POST", path: "/sync/push", expose: true, auth: true },
  async (req: PushRequest): Promise<PushResponse> => {
    const userId = getAuthData()!.userID;
    const workspaces = checkRows(req.workspaces, "workspaces");
    const notes = checkRows(req.notes, "notes");

    let prefs: { json: string; updatedAt: Date } | undefined;
    if (req.preferences) {
      prefs = {
        json: checkData(req.preferences.data, "preferences"),
        updatedAt: parseDate(req.preferences.updatedAt, "preferences.updatedAt"),
      };
    }

    const telemetry = (req.telemetry ?? []).map((t, i) => {
      if (typeof t?.id !== "string" || !ID_RE.test(t.id)) bad(`telemetry[${i}].id is invalid`);
      return {
        id: t.id,
        json: checkData(t.data, `telemetry[${i}]`),
        createdAt: parseDate(t.createdAt, `telemetry[${i}].createdAt`),
      };
    });
    if (telemetry.length > MAX_ROWS) bad(`telemetry: max ${MAX_ROWS} rows per push`);

    const acceptedWs = await upsertRows(userId, "workspaces", workspaces);
    const acceptedNotes = await upsertRows(userId, "notes", notes);

    if (prefs) {
      await db.exec`
        INSERT INTO preferences (user_id, data, updated_at)
        VALUES (${userId}, (${prefs.json}::jsonb #>> '{}')::jsonb, ${prefs.updatedAt})
        ON CONFLICT (user_id) DO UPDATE
          SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, synced_at = now()
          WHERE EXCLUDED.updated_at > preferences.updated_at`;
    }
    for (const t of telemetry) {
      await db.exec`
        INSERT INTO telemetry_events (user_id, id, data, created_at)
        VALUES (${userId}, ${t.id}, (${t.json}::jsonb #>> '{}')::jsonb, ${t.createdAt})
        ON CONFLICT (user_id, id) DO NOTHING`;
    }

    return {
      accepted: { workspaces: acceptedWs, notes: acceptedNotes },
      serverTime: new Date().toISOString(),
    };
  },
);

// `data` is selected as text and parsed here: the driver otherwise hands jsonb back as a string.
interface DbRow {
  id: string;
  data: string;
  updated_at: Date;
  deleted: boolean;
}
const toRow = (r: DbRow): Row => ({
  id: r.id,
  data: JSON.parse(r.data) as Record<string, unknown>,
  updatedAt: r.updated_at.toISOString(),
  deleted: r.deleted,
});

export const pull = api(
  { method: "GET", path: "/sync/pull", expose: true, auth: true },
  async (req: PullRequest): Promise<PullResponse> => {
    const userId = getAuthData()!.userID;
    // Cursor from the DB clock, 5s early: rows committing during this pull are re-sent next
    // time rather than skipped (re-applying them is harmless under last-write-wins).
    const t = await db.queryRow<{ t: Date }>`SELECT now() - interval '5 seconds' AS t`;
    const serverTime = t!.t.toISOString();
    const since = req.since ? parseDate(req.since, "since") : new Date(0);

    const workspaces: Row[] = [];
    for await (const r of db.query<DbRow>`
      SELECT id, data::text AS data, updated_at, deleted FROM workspaces
      WHERE user_id = ${userId} AND synced_at > ${since} ORDER BY synced_at`) {
      workspaces.push(toRow(r));
    }
    const notes: Row[] = [];
    for await (const r of db.query<DbRow>`
      SELECT id, data::text AS data, updated_at, deleted FROM notes
      WHERE user_id = ${userId} AND synced_at > ${since} ORDER BY synced_at`) {
      notes.push(toRow(r));
    }
    const p = await db.queryRow<{ data: string; updated_at: Date }>`
      SELECT data::text AS data, updated_at FROM preferences WHERE user_id = ${userId} AND synced_at > ${since}`;

    return {
      workspaces,
      notes,
      preferences: p ? { data: JSON.parse(p.data) as Record<string, unknown>, updatedAt: p.updated_at.toISOString() } : null,
      serverTime,
    };
  },
);
