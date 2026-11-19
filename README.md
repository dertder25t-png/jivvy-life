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

## Daily use / testing

- The app launcher **Jivvy Life** is the one install (binary at `~/.local/bin/jivvy-life`).
- After changing code, update it with `cd app && npm run app:install` (builds and replaces the binary, launcher and icons).
- `npm run app:dev` opens a temporary hot-reload window for development. It is not an install.
- There is no AppImage for local use: the AppImage bundles its own WebKit, which crashes on this machine, so local installs use the system WebKit. In-app updates only work in AppImage builds (the GitHub release); a source install shows an "Installed from source" note instead.

## Ad & tracker blocking (app)

Pane webviews (never the app UI) get WebKit content rules built from EasyList and EasyPrivacy
(domain-only, third-party-only rules, plus a hard-coded never-block list for school, SSO, Google and
GitHub sites). The converted rules are committed in `app/src-tauri/blocklist/blocklist.json` and
embedded in the binary; the app never downloads lists at runtime. WebKit compiles them once on first
start and caches the result in the app data dir. Toggle blocking, or turn it off per site, in
Settings > Privacy or with the shield button in the address bar.

Refresh the lists with `cd app && node scripts/update-blocklist.mjs`, then review the diff before committing.

## Releasing an update

1. Bump `version` in `app/src-tauri/tauri.conf.json` (and `app/package.json`) and commit.
2. `git tag vX.Y.Z && git push --tags`

GitHub Actions builds, signs and publishes the release; installed apps then show the
update in Settings, with an "Update & restart" button. Requires the repo secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
