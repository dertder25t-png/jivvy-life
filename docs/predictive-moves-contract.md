# Predictive moves — shared contract (v0.4.0)

Every part (extension, helper, miner, laya) follows these shapes. Personal data never goes in the repo.

## Move ids (seeded, status "new" on first run)
`nav_shortcut_interceptor`, `search_frustration_escalator`, `canvas_study_bridge`, `creative_asset_router`, `inline_unit_camera_calc`.
Discovered moves use the id `seq_<hostA>_<hostB>_<hostC>` (dots → `-`).

## storage.local keys (extension)
- `moves`: `{ [id]: { status: "new"|"enabled"|"disabled"|"dismissed", threshold: 0.85 } }`
- `staged`: array of staged items, newest first, at most 12:
  `{ id: string (unique), move: <move id>, label: string, confidence: 0..1, source: "rule"|"laya", t: ms, expires: ms|null,
     action: { type: "open", url } | { type: "ask", route: "claude"|"gemini", text } | { type: "copy-open", text, url }
           | { type: "files", files: [{name, path, size, mtime}] } | { type: "move", names: [..], dest } | { type: "undo-move", pairs: [[from,to],..] },
     tabsSeen: number }`
- `moveLabels`: capped 2000, `{ move, outcome: "fired"|"dismissed"|"ignored", weight: 1|1|0.3, t, source }`
  (fired = positive; dismissed = strong negative; ignored = weak negative, only on time expiry or after 8+ new tabs unused)
- `ring`: last 5 events `{ kind: "visit"|"download", host, path, query?, engine?, title?, ext?, name?, t, hour }`
- `learned`: `{ t, navAliases: { "<typed text lowercased>": "<url>" }, canvasCourses: { "<id>": { name, exts: [..] } }, name?, counts: { [move id]: { n, note } }, discovered: [discovered move] }`
  Merged under the user's Options settings (user wins).

## Native helper (`hub_helper`) actions — request → reply
- `{action:"recent_files", minutes:30, exts:["tif","jpg"]}` → `{ok, dir, files:[{name, path, size, mtime}]}` (~/Downloads only, newest first, max 20)
- `{action:"reveal", path}` → `{ok}` (path must be inside ~/Downloads or allowed_roots; runs `dolphin --select <path>`, falls back to `xdg-open <dir>`)
- `{action:"move_files", names:[..], dest}` → `{ok, pairs:[[from,to],..], skipped:[{name, why}]}`
  names are bare file names in ~/Downloads; dest must be an existing dir inside allowed_roots; never overwrites (adds ` (1)`).
- `{action:"undo_move", pairs:[[from,to],..]}` → `{ok, pairs, skipped}` (moves `to` back to `from` only if `from` is free and both are in allowed places)
- `{action:"stage", move: <staged item>|null}` → `{ok, fired:[{move, t}]}` writes `$XDG_RUNTIME_DIR/hub-dashboard/next_move.json` (dir 700, file 600; null deletes it), returns and clears `fired.jsonl` next to it.
  Shape written: `{ move, label, confidence, threshold, url, expires }` — only for action.type "open"/"ask" (url precomputed by the extension); otherwise the file is deleted.
- `{action:"discovered"}` → `{ok, learned: <same shape as storage key "learned">}` (reads `~/.local/share/hub-dashboard/discovered_moves.json` and `seed_local.json`, seed values under discovered ones) or `{ok:false, error}`
- `{action:"mine"}` → runs `pattern_miner.py` (timeout 120 s), then same reply as `discovered`.

## Files on disk (mode 600, dirs 700)
- `~/.local/share/hub-dashboard/discovered_moves.json`: `{ t, navAliases, canvasCourses, counts, discovered: [{ id, hosts:[a,b,c], n, days, label, url, laya: {should_stage, p} | null }] }`
- `~/.local/share/hub-dashboard/seed_local.json`: `{ t, navAliases, canvasCourses, name? , unmatched: [typo list entries with no visited target] }`
- `~/.config/hub-dashboard/laya-token`: random hex, 600.

## laya `/workflow`
`POST http://127.0.0.1:8770/workflow` with either Origin `moz-extension://…` or header `X-Hub-Token: <token>`.
Body `{ "state": "<plain-text summary of recent events>", "moves": ["<enabled move id>", ...] }`
Reply `{ ok, should_stage: {choice:"yes"|"no"|"unsure", p}, next_move: {choice:"<id>"|"none", p, probs}, ms }` or `{ok:false, error}`.
Must not change the existing `QUESTIONS` dict (its hash keys the saved fit).

## Global shortcut
`helper/lifeboard-next` (Meta+Shift+.): reads next_move.json; fires `xdg-open url` only if not expired, http(s), and confidence ≥ threshold; appends `{move, t}` to `fired.jsonl`. `--dry-run` prints the decision.

## Compact workflow state (v0.4.1)
laya `/workflow` and all training rows use the same compact state: a JSON **array of short strings**, oldest first, at most 5:
- visit: `host/path` (lowercased host without `www.`, path cut at 40 chars, no query string except search terms; numeric ids kept, e.g. `school.instructure.com/courses/123/assignments/456`)
- search: `<engine>:q=<query>` (engine = google | duckduckgo | bing | pinterest | pexels | pixabay | magnific | unsplash | freepik; query lowercased, trimmed to 60 chars; tracking params like sxsrf, gs_lp, ved, ei, oq, aqs, token are never included)
- download: `dl:<basename>` (cut to 40 chars)
Python reference: `helper/workflow_state.py` (`compact_url(url)`, `compact_download(name)`, `to_text(state)`); JS twin in `extension/core/moves.js` (`compactEvent(ev)`). `to_text` joins with `" → "`. Both must produce identical strings for the same input (shared test vectors in `tests/workflow_state_vectors.json`).
Request body may send `state` as that array (preferred) or a plain string (old form).

## Workflow training rows
JSONL, one row per line, mode 600, all under `~/.local/share/hub-dashboard/` (never in git):
`{"state": [..compact strings..], "next_move": "<move id>|none", "should_stage": true|false, "source": "seed"|"auto_pos"|"auto_neg"|"human", "why"?: "..."}`
- `workflow_training_seed.jsonl` — hand-written gold rows
- `workflow_mined.jsonl` — `train_workflow_cli.py --mine` auto labels (auto_pos, auto_neg)
- `workflow_edge_cases.jsonl` — unlabelled near-miss sessions for `--interactive`
- `workflow_labels.jsonl` — rows you labelled in `--interactive` (source human)
- benchmark (held out, never trained on): `helper/workflow_benchmark.json` in git, generic sites only (the 8 test cases, rewritten in compact form).
Fit saved to `~/.local/share/hub-dashboard/workflow-fit/` with its own `labels.sha256` — separate from `vega-fit/` (the destination fit must stay byte-identical).
