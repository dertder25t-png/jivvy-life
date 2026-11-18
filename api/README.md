# Jivvy Life API

Encore.ts backend for the Jivvy Life desktop app. One Postgres database (`jivvy`, migrations in `auth/migrations`).

## Endpoints

Auth (`Authorization: Bearer <token>` for authenticated routes; sessions last 60 days):
- `POST /auth/signup` `{email, password(min 8)}` -> `{token, userId, email}`
- `POST /auth/login` same body/response (rate-limited per email, in memory)
- `POST /auth/logout` (auth), `GET /auth/me` (auth) -> `{userId, email}`

Sync (all require auth, scoped to the authenticated user; last-write-wins on `updatedAt`):
- `POST /sync/push` `{workspaces?, notes?, preferences?, telemetry?}` -> `{accepted:{workspaces,notes}, serverTime}` (max 500 rows per list, 1MB per row)
- `GET /sync/pull?since=<ISO>` -> `{workspaces, notes, preferences|null, serverTime}` (includes `deleted` tombstones)

CORS allows `localhost:1420` and the Tauri origins (see `encore.app`).

## Develop / deploy

- Local: `encore run` (needs Docker for the database); type-check with `npx tsc --noEmit`, `encore check`.
- Deploy: `git push encore` (after adding the Encore remote: `git remote add encore encore://jivvy-life-api-ei5i`).
