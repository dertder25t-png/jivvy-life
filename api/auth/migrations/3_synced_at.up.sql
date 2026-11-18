-- Server-side change stamp for pull cursors. Client updated_at decides last-write-wins;
-- synced_at (DB clock) decides what a device hasn't seen yet, so late uploads of old edits still reach it.
ALTER TABLE workspaces ADD COLUMN synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE notes ADD COLUMN synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE preferences ADD COLUMN synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX workspaces_user_synced ON workspaces (user_id, synced_at);
CREATE INDEX notes_user_synced ON notes (user_id, synced_at);
