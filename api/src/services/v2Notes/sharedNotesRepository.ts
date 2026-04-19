import type { Notification, Pool, Client } from 'pg';

const SHARED_NOTES_DOCUMENT_ID = 'v2:notes.md';
const SHARED_NOTES_CHANNEL = 'v2_shared_notes_updates';

type SharedNotesRow = {
  id: string;
  content: string;
  revision: number | string;
  updatedAt: string | Date;
};

export type SharedNotesDocument = {
  id: string;
  content: string;
  revision: number;
  updatedAt: string;
};

export type SharedNotesRepositoryDeps = {
  /** Pool used for read/write queries. Can be transaction-pooled. */
  pool: Pool;
  /** Factory for a dedicated session-mode client used for LISTEN. Must support LISTEN. */
  createListenerClient: () => Promise<Client>;
};

function mapSharedNotesRow(row: SharedNotesRow): SharedNotesDocument {
  return {
    id: row.id,
    content: row.content,
    revision: Number(row.revision),
    updatedAt: new Date(row.updatedAt).toISOString()
  };
}

export class SharedNotesRepository {
  constructor(private readonly deps: SharedNotesRepositoryDeps) {}

  async getDocument(): Promise<SharedNotesDocument> {
    await this.ensureDocument();

    const result = await this.deps.pool.query<SharedNotesRow>(
      `select
          id,
          content,
          revision,
          updated_at as "updatedAt"
        from shared_documents
        where id = $1
        limit 1`,
      [SHARED_NOTES_DOCUMENT_ID]
    );

    if (result.rowCount !== 1) {
      throw new Error('Shared notes document not found');
    }

    return mapSharedNotesRow(result.rows[0]);
  }

  async saveDocument(content: string, baseRevision: number | null): Promise<SharedNotesDocument> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('begin');

      const result = await client.query<SharedNotesRow>(
        `insert into shared_documents (id, content, revision)
         values ($1, $2, 1)
         on conflict (id) do update
           set content = excluded.content,
               revision = shared_documents.revision + 1,
               updated_at = now()
         returning
           id,
           content,
           revision,
           updated_at as "updatedAt"`,
        [SHARED_NOTES_DOCUMENT_ID, content]
      );

      const document = mapSharedNotesRow(result.rows[0]);

      await client.query('select pg_notify($1, $2)', [
        SHARED_NOTES_CHANNEL,
        JSON.stringify({
          id: SHARED_NOTES_DOCUMENT_ID,
          revision: document.revision,
          baseRevision
        })
      ]);

      await client.query('commit');
      return document;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Opens a dedicated session-mode pg client and subscribes to
   * `v2_shared_notes_updates`. Each notification triggers a fresh doc read,
   * which is then pushed to the caller. Returns a disposer.
   */
  async listen(onUpdate: (document: SharedNotesDocument) => Promise<void> | void): Promise<() => Promise<void>> {
    const client = await this.deps.createListenerClient();

    const handleNotification = async (notification: Notification) => {
      if (notification.channel !== SHARED_NOTES_CHANNEL) {
        return;
      }
      const document = await this.getDocument();
      await onUpdate(document);
    };

    client.on('notification', handleNotification);
    await client.query(`LISTEN ${SHARED_NOTES_CHANNEL}`);

    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      client.off('notification', handleNotification);
      try {
        await client.query(`UNLISTEN ${SHARED_NOTES_CHANNEL}`);
      } catch {}
      try {
        await client.end();
      } catch {}
    };
  }

  private async ensureDocument(): Promise<void> {
    await this.deps.pool.query(
      `insert into shared_documents (id, content, revision)
        values ($1, '', 0)
        on conflict (id) do nothing`,
      [SHARED_NOTES_DOCUMENT_ID]
    );
  }
}
