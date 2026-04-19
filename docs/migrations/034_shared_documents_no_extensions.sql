BEGIN;

-- Shared notes substrate for the innies-work /v2 leave-a-note.md tab.
-- Backed by a single row per document id (MVP: one `v2:notes.md` document).
-- The app issues pg_notify on `v2_shared_notes_updates` after each save, and
-- SSE clients LISTEN on that channel to push live updates across open tabs.

CREATE TABLE IF NOT EXISTS shared_documents (
  id          text PRIMARY KEY,
  content     text NOT NULL DEFAULT '',
  revision    bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the primary v2 notes document so the first GET request succeeds
-- without forcing a write-first bootstrap.
INSERT INTO shared_documents (id, content, revision)
VALUES ('v2:notes.md', '', 0)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'niyant') THEN
    GRANT ALL PRIVILEGES ON TABLE shared_documents TO niyant;
  END IF;
END $$;

COMMIT;
