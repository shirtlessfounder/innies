BEGIN;

CREATE TABLE IF NOT EXISTS am_rooms (
  id text PRIMARY KEY,
  room_stem text,
  host_token text NOT NULL,
  guest_token text,
  status text NOT NULL DEFAULT 'waiting',
  opening_message_id bigint,
  host_connected_at timestamptz,
  guest_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  CONSTRAINT chk_am_rooms_status CHECK (status IN ('waiting', 'active', 'closed', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_am_rooms_room_stem
  ON am_rooms (room_stem)
  WHERE room_stem IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_am_rooms_host_token
  ON am_rooms (host_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_am_rooms_guest_token
  ON am_rooms (guest_token)
  WHERE guest_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS am_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id text NOT NULL REFERENCES am_rooms(id) ON DELETE CASCADE,
  sender text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_am_messages_sender CHECK (sender IN ('host', 'guest'))
);

CREATE INDEX IF NOT EXISTS idx_am_messages_room_created
  ON am_messages (room_id, created_at ASC, id ASC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_am_rooms_opening_message_id'
  ) THEN
    ALTER TABLE am_rooms
      ADD CONSTRAINT fk_am_rooms_opening_message_id
      FOREIGN KEY (opening_message_id)
      REFERENCES am_messages(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS am_invites (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id text NOT NULL REFERENCES am_rooms(id) ON DELETE CASCADE,
  participant_role text NOT NULL DEFAULT 'guest',
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_idempotency_key text,
  claim_session_token text,
  claim_guest_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_am_invites_participant_role CHECK (participant_role IN ('host', 'guest'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_am_invites_token_hash
  ON am_invites (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_am_invites_room_role
  ON am_invites (room_id, participant_role);

CREATE INDEX IF NOT EXISTS idx_am_invites_room_id
  ON am_invites (room_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'niyant'
  ) THEN
    GRANT ALL PRIVILEGES ON TABLE am_rooms TO niyant;
    GRANT ALL PRIVILEGES ON TABLE am_messages TO niyant;
    GRANT ALL PRIVILEGES ON TABLE am_invites TO niyant;
    GRANT ALL PRIVILEGES ON SEQUENCE am_messages_id_seq TO niyant;
    GRANT ALL PRIVILEGES ON SEQUENCE am_invites_id_seq TO niyant;
  END IF;
END $$;

COMMIT;
