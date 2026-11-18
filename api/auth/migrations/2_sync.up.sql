CREATE TABLE workspaces (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX workspaces_updated_idx ON workspaces(user_id, updated_at);

CREATE TABLE notes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX notes_updated_idx ON notes(user_id, updated_at);

CREATE TABLE preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE telemetry_events (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, id)
);
