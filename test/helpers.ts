import * as sqlite from '../src/bun-sqlite';
import { migrate } from './fixtures';

// ─── type-level assertions, checked by `bun check` ───────────────────────────

export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const assert = <_ extends true>() => { };

// flattens an object type, so that `A & B` equals `{ ...A, ...B }`
export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

export type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
export type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

// ─── database ────────────────────────────────────────────────────────────────

export type Database = ReturnType<typeof sqlite.connect>;

// a migrated in-memory database, plus every statement it runs after migrating
export const fresh = async () => {
  const sqls: string[] = [];
  const db = sqlite.connect(':memory:', { loggers: [{ debug: (sql: string) => sqls.push(sql), error: () => { } }] });

  await migrate(db);
  sqls.length = 0;

  return { db, sqls };
};

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
