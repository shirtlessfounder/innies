import { Client, Pool } from 'pg';
import { SharedNotesRepository } from './sharedNotesRepository.js';

let cachedRepo: SharedNotesRepository | null = null;

function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value || value.trim().length === 0) {
    throw new Error('DATABASE_URL is required for shared notes');
  }
  return value;
}

function readListenerDatabaseUrl(): string {
  // LISTEN requires a session-mode pg connection; Supabase's transaction
  // pooler (:6543) re-allocates sessions per statement and does not keep
  // LISTEN subscriptions alive. Use the session pooler (:5432) via a
  // dedicated env var so the runtime DATABASE_URL can stay on the
  // transaction pooler for regular writes.
  const value = process.env.NOTES_LISTEN_DATABASE_URL?.trim();
  if (value && value.length > 0) {
    return value;
  }

  // Fallback: if only DATABASE_URL is provided AND it points at a Supabase
  // supavisor host, swap :6543 → :5432 to reach the session pooler. This
  // is a convenience for single-URL deployments; prefer explicit
  // NOTES_LISTEN_DATABASE_URL in prod.
  const fallback = readDatabaseUrl();
  if (fallback.includes(':6543/')) {
    return fallback.replace(':6543/', ':5432/');
  }
  return fallback;
}

export function getSharedNotesRepository(): SharedNotesRepository {
  if (cachedRepo) return cachedRepo;

  const pool = new Pool({
    connectionString: readDatabaseUrl(),
    max: 5
  });

  const createListenerClient = async (): Promise<Client> => {
    const client = new Client({
      connectionString: readListenerDatabaseUrl()
    });
    await client.connect();
    return client;
  };

  cachedRepo = new SharedNotesRepository({ pool, createListenerClient });
  return cachedRepo;
}
