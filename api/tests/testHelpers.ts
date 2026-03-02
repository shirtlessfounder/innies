import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';

export type CapturedQuery = {
  sql: string;
  params?: SqlValue[];
};

export class MockSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];

  constructor(private readonly defaultResult: SqlQueryResult = { rows: [], rowCount: 1 }) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    return this.defaultResult as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

export function createLoggerSpy() {
  const infoCalls: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const errorCalls: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  return {
    logger: {
      info(message: string, fields?: Record<string, unknown>) {
        infoCalls.push({ message, fields });
      },
      error(message: string, fields?: Record<string, unknown>) {
        errorCalls.push({ message, fields });
      }
    },
    infoCalls,
    errorCalls
  };
}
