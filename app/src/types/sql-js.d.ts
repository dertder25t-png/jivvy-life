// Minimal ambient types for the subset of sql.js used by importService.ts.
declare module 'sql.js' {
  export type SqlValue = string | number | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Database {
    exec(sql: string): QueryExecResult[];
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
