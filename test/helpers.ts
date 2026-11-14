import { afterAll, describe } from 'bun:test';
import { type IDatabase, type ILogger, exec } from '../src';
import * as pg from '../src/bun-postgres';
import * as sqlite from '../src/bun-sqlite';
import { migrate } from './fixtures';

// ─── type-level assertions, checked by `bun check` ───────────────────────────

export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const assert = <_ extends true>() => { };

// flattens an object type, so that `A & B` equals `{ ...A, ...B }`
export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

export type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
export type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

// ─── adapters ────────────────────────────────────────────────────────────────

export type Database = IDatabase;

type Connection = IDatabase & { close(): Promise<void> };
type Index = { unique: boolean, columns: string[] };

type Adapter = {
  name: string;
  skip: boolean;
  // an empty database, reusing `previous` where it's worth it
  fresh: (previous: Connection | undefined, logger: ILogger) => Promise<Connection>;
  // reads the schema back from the database's own catalog
  columnsOf: (db: Database, table: string) => Promise<string[]>;
  indexesOf: (db: Database, table: string) => Promise<Index[]>;
};

// postgres suites only run when a database is available, e.g.:
// docker run --rm -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
// EXTO_PG_URL=postgres://postgres:pg@localhost:55432/postgres bun test
const PG_URL = process.env['EXTO_PG_URL'];

const adapters: Adapter[] = [
  {
    name: 'bun-sqlite',
    skip: false,
    fresh: async (previous, logger) => {
      await previous?.close();
      return sqlite.connect(':memory:', { loggers: [logger] });
    },
    columnsOf: async (db, table) => (await db.execute(`PRAGMA table_info("${table}")`, [])).map(col => col['name'] as string),
    indexesOf: async (db, table) => {
      const indexes = (await db.execute(`PRAGMA index_list("${table}")`, [])).filter(index => !(index['name'] as string).startsWith('sqlite_autoindex_'));

      return await Promise.all(indexes.map(async index => ({
        unique: Number(index['unique']) === 1,
        columns: (await db.execute(`PRAGMA index_info("${index['name']}")`, [])).map(col => col['name'] as string),
      })));
    },
  },
  {
    name: 'bun-postgres',
    skip: PG_URL === undefined,
    // one connection pool per suite, emptied before every test
    fresh: async (previous, logger) => {
      const db = previous ?? pg.connect(PG_URL!, { loggers: [logger] });
      await exec(db, 'DROP TABLE IF EXISTS "tasks", "users", "things", "schema_migrations"');
      await exec(db, 'CREATE EXTENSION IF NOT EXISTS citext');
      return db;
    },
    columnsOf: async (db, table) => {
      const sql = 'SELECT "column_name" FROM "information_schema"."columns" WHERE "table_schema" = current_schema() AND "table_name" = $1 ORDER BY "ordinal_position"';
      return (await db.execute(sql, [table])).map(col => col['column_name'] as string);
    },
    indexesOf: async (db, table) => {
      const sql = `
        SELECT i."indisunique" AS "unique", string_agg(a."attname", ',' ORDER BY k."ord") AS "columns"
        FROM "pg_index" i
        JOIN "pg_class" t ON t."oid" = i."indrelid"
        JOIN LATERAL unnest(i."indkey") WITH ORDINALITY AS k("attnum", "ord") ON true
        JOIN "pg_attribute" a ON a."attrelid" = t."oid" AND a."attnum" = k."attnum"
        WHERE t."relname" = $1 AND t."relnamespace" = current_schema()::regnamespace AND NOT i."indisprimary"
        GROUP BY i."indexrelid", i."indisunique"
        ORDER BY i."indexrelid"`;

      return (await db.execute(sql, [table])).map(index => ({ unique: index['unique'] as boolean, columns: (index['columns'] as string).split(',') }));
    },
  },
];

type Fresh = (options?: { migrate?: boolean }) => Promise<{ db: Database, sqls: string[] }>;

// runs the suite once per adapter. `fresh` hands each test an empty
// database (migrated, unless told otherwise), plus every statement it runs
// from then on
export const suite = (name: string, fn: (fresh: Fresh, adapter: Adapter) => void) => {
  for (const adapter of adapters) {
    describe.skipIf(adapter.skip)(`${name} [${adapter.name}]`, () => {
      const sqls: string[] = [];
      const logger: ILogger = { debug: (sql) => { sqls.push(sql); }, error: () => { } };
      let db: Connection | undefined;

      afterAll(async () => {
        await db?.close();
      });

      fn(async ({ migrate: migrated = true } = {}) => {
        db = await adapter.fresh(db, logger);
        if (migrated) await migrate(db);
        sqls.length = 0;

        return { db, sqls };
      }, adapter);
    });
  }
};

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
