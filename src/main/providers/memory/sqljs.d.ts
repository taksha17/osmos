/**
 * Minimal typings for `sql.js` — only the surface this project uses.
 *
 * Written here rather than pulled from `@types/sql.js` so the dependency list
 * stays at what the app actually ships, and so the WASM package can be swapped
 * for another driver without dragging type packages along.
 */
declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;

  export type Database = {
    run(sql: string, params?: SqlValue[]): void;
    exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
    export(): Uint8Array;
    close(): void;
  };

  export type SqlJsStatic = {
    Database: new (data?: Uint8Array | null) => Database;
  };

  export type SqlJsConfig = {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer;
  };

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
