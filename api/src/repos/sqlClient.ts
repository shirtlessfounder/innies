export type SqlValue = string | number | boolean | null | Date | Buffer | Record<string, unknown> | unknown[];

export type SqlQueryResult<T = Record<string, unknown>> = {
  rows: T[];
  rowCount: number;
};

export interface TransactionContext {
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>>;
}

export interface SqlClient extends TransactionContext {
  transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
