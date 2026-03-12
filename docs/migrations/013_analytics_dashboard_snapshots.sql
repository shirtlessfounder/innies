CREATE TABLE IF NOT EXISTS in_analytics_dashboard_snapshots (
  cache_key text PRIMARY KEY,
  dashboard_window text NOT NULL,
  provider text,
  source text,
  payload jsonb NOT NULL,
  snapshot_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_in_analytics_dashboard_snapshots_refreshed
  ON in_analytics_dashboard_snapshots (refreshed_at desc);
