BEGIN;

CREATE TABLE IF NOT EXISTS in_rate_card_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_version_id uuid NOT NULL REFERENCES in_rate_card_versions(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model_pattern text NOT NULL,
  routing_mode in_routing_mode NOT NULL,
  buyer_debit_minor_per_unit bigint NOT NULL DEFAULT 0,
  contributor_earnings_minor_per_unit bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_card_version_id, provider, model_pattern, routing_mode)
);

CREATE INDEX IF NOT EXISTS idx_in_rate_card_line_items_lookup
  ON in_rate_card_line_items (rate_card_version_id, provider, routing_mode, model_pattern);

INSERT INTO in_rate_card_versions (
  id,
  version_key,
  effective_at,
  created_at
) VALUES (
  '01901901-9019-4019-8019-019019019019',
  'phase2-bootstrap',
  '2026-03-20T00:00:00Z',
  now()
)
ON CONFLICT (version_key) DO NOTHING;

INSERT INTO in_rate_card_line_items (
  id,
  rate_card_version_id,
  provider,
  model_pattern,
  routing_mode,
  buyer_debit_minor_per_unit,
  contributor_earnings_minor_per_unit,
  currency,
  created_at
) VALUES
  ('01901911-9019-4019-8019-019019019011', '01901901-9019-4019-8019-019019019019', 'anthropic', '*', 'self-free', 0, 0, 'USD', now()),
  ('01901912-9019-4019-8019-019019019012', '01901901-9019-4019-8019-019019019019', 'anthropic', '*', 'paid-team-capacity', 0, 0, 'USD', now()),
  ('01901913-9019-4019-8019-019019019013', '01901901-9019-4019-8019-019019019019', 'anthropic', '*', 'team-overflow-on-contributor-capacity', 0, 0, 'USD', now()),
  ('01901921-9019-4019-8019-019019019021', '01901901-9019-4019-8019-019019019019', 'openai', '*', 'self-free', 0, 0, 'USD', now()),
  ('01901922-9019-4019-8019-019019019022', '01901901-9019-4019-8019-019019019019', 'openai', '*', 'paid-team-capacity', 0, 0, 'USD', now()),
  ('01901923-9019-4019-8019-019019019023', '01901901-9019-4019-8019-019019019019', 'openai', '*', 'team-overflow-on-contributor-capacity', 0, 0, 'USD', now())
ON CONFLICT (rate_card_version_id, provider, model_pattern, routing_mode) DO NOTHING;

COMMIT;
