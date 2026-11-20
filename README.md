# Jivvy Life

A desktop workspace for Linux (Electron + React): multi-tab browsing with workspaces and split panes,
Markdown notes, ad/tracker blocking, local history with address-bar predictions, and sync through its own
Encore API. The project originally grew out of Lifeboard, a Firefox new-tab extension.

| Folder | What | Run it |
|---|---|---|
| `app/` | Desktop app (Electron, React, Zustand) | `cd app && npm install && npm run electron:dev` |
| `api/` | Sync + sign-in API (Encore.ts, Postgres) | `cd api && npm install && encore run` (needs Docker) |

Encore Cloud deploys from this repo: set the app's **root directory to `api/`** in the
Encore dashboard's GitHub settings.

## Daily use

Open **Jivvy Life** from your app launcher. It is one install: the app lives in `~/.local/lib/jivvy-life`,
with a `~/.local/bin/jivvy-life` command and a launcher entry. It is registered as a possible web browser
but is never set as your default automatically.

## Updating after code changes

```
cd app && npm run app:install
```

This packages the app and swaps it in atomically, so it is safe while the app is open; restart the app to
run the new version. `npm run app:uninstall` removes the install and keeps your data.

## Development

```
cd app
npm run electron:dev        # hot-reload window (not an install)
npm run electron:build      # typecheck + build
npm run electron:package    # package to app/out/jivvy-life-linux-x64/
npm run electron:selftest   # end-to-end self-test with a scratch profile
```

## Video codecs

Electron ships its own codecs, but H.264 video on some sites still depends on system GStreamer/VA-API
setups. If YouTube or similar sites show no video, install:

```
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-libav
```

`npm run app:install` warns if these are missing.

## Signing in to Google

Google blocks sign-in from embedded browsers. Instead, import your session from Firefox:
Settings > "Import Firefox sessions" (copies your cookies). Stay signed in to Google in
Firefox, then import.

## Ad & tracker blocking

Page requests are checked against a domain list built from EasyList and EasyPrivacy
(`app/blocklist/blocklist.json`, with a never-block list for school, SSO, Google and GitHub sites). Nothing
is downloaded at runtime. Toggle it in Settings > Privacy or with the shield in the address bar. Refresh
the lists with `cd app && node scripts/update-blocklist.mjs` and review the diff.

## Where your data lives

`~/.config/jivvy-life/`: `jivvy-state.json` (workspaces, notes, settings), `history.sqlite`,
`predictions.json`, `predictions-eval.jsonl`. Saved logins are encrypted with the system keyring
(Electron safeStorage). Uninstalling never touches this folder.
