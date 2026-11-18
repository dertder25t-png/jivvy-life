-- Repair rows stored double-encoded (a jsonb string holding the JSON text) before the insert fix.
UPDATE workspaces SET data = (data #>> '{}')::jsonb WHERE jsonb_typeof(data) = 'string';
UPDATE notes SET data = (data #>> '{}')::jsonb WHERE jsonb_typeof(data) = 'string';
UPDATE preferences SET data = (data #>> '{}')::jsonb WHERE jsonb_typeof(data) = 'string';
UPDATE telemetry_events SET data = (data #>> '{}')::jsonb WHERE jsonb_typeof(data) = 'string';
