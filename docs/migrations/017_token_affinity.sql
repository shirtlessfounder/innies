create table if not exists in_token_affinity_assignments (
  org_id uuid not null,
  provider text not null,
  credential_id uuid not null,
  session_id text not null,
  last_activity_at timestamptz not null default now(),
  grace_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider, credential_id),
  unique (org_id, provider, session_id)
);

create table if not exists in_token_affinity_active_streams (
  request_id text primary key,
  org_id uuid not null,
  provider text not null,
  credential_id uuid not null,
  session_id text not null,
  started_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_in_token_affinity_assignments_session
  on in_token_affinity_assignments (org_id, provider, session_id);

create index if not exists idx_in_token_affinity_assignments_grace
  on in_token_affinity_assignments (org_id, provider, grace_expires_at);

create index if not exists idx_in_token_affinity_active_streams_partition
  on in_token_affinity_active_streams (org_id, provider, credential_id);

create index if not exists idx_in_token_affinity_active_streams_stale
  on in_token_affinity_active_streams (last_touched_at)
  where ended_at is null;
