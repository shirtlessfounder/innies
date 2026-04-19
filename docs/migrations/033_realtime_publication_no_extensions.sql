BEGIN;

-- Expose the live-session substrate to Supabase Realtime so UI clients can
-- subscribe to new turns as they land. Hosted Supabase ships a publication
-- named `supabase_realtime` that WAL-streams INSERT/UPDATE/DELETE events over
-- websockets to subscribed clients.
--
-- Guarded so this migration is a no-op on any pg instance that does not have
-- the `supabase_realtime` publication (plain pg, CI, sf-prod RDS legacy, etc).
-- Adding a table that is already in the publication is idempotent on current
-- pg versions via ALTER PUBLICATION ... ADD TABLE; we guard each ADD with a
-- pg_publication_tables check so the migration stays re-runnable.

DO $$
DECLARE
  target_tables text[] := ARRAY[
    'in_request_attempt_archives',
    'in_request_attempt_messages',
    'in_message_blobs'
  ];
  tbl text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE NOTICE 'supabase_realtime publication not present; skipping (non-Supabase pg)';
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY target_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
      RAISE NOTICE 'added %.% to supabase_realtime publication', 'public', tbl;
    END IF;
  END LOOP;
END $$;

-- No niyant grant changes: this migration only alters a Supabase-managed
-- publication. The underlying tables already have niyant grants from
-- migration 024. Publications do not have grantable surface of their own.

COMMIT;
