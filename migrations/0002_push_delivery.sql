CREATE TABLE IF NOT EXISTS push_deliveries (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('sent', 'expired')),
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (event_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS push_deliveries_event ON push_deliveries(event_id);
