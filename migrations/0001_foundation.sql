PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  trigger_token_hash TEXT NOT NULL, management_token_hash TEXT NOT NULL,
  trigger_token_version INTEGER NOT NULL DEFAULT 1, management_token_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, notifications_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS creation_requests (
  request_id TEXT PRIMARY KEY, recovery_hash TEXT NOT NULL, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  result_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, endpoint_fingerprint TEXT NOT NULL UNIQUE, vendor_url TEXT NOT NULL,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS endpoint_devices (
  endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE, subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL, method TEXT NOT NULL, content_type TEXT, byte_count INTEGER NOT NULL,
  idempotency_key TEXT, UNIQUE(endpoint_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS events_endpoint_received ON events(endpoint_id, received_at DESC);
CREATE INDEX IF NOT EXISTS creation_requests_expiry ON creation_requests(expires_at);
