# Jivvy Life

A desktop workspace (Tauri 2 + React) with a Lifeboard-style dashboard, multi-tab browsing,
Markdown notes, and sync through its own Encore API.

| Folder | What | Run it |
|---|---|---|
| `app/` | Desktop app (Tauri 2, React, Zustand) | `cd app && npm install && npx tauri dev` |
| `api/` | Sync + sign-in API (Encore.ts, Postgres) | `cd api && npm install && encore run` (needs Docker) |

Encore Cloud deploys from this repo: set the app's **root directory to `api/`** in the
Encore dashboard's GitHub settings.

The previous project in this repo, the Lifeboard Firefox extension, is kept at tag
`lifeboard-v0.4`.

## Releasing an update

1. Bump `version` in `app/src-tauri/tauri.conf.json` (and `app/package.json`) and commit.
2. `git tag vX.Y.Z && git push --tags`

GitHub Actions builds, signs and publishes the release; installed apps then show the
update in Settings, with an "Update & restart" button. Requires the repo secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
