import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { Codec, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, string> = {
  BIGINT:   'INTEGER',
  BINARY:   'BLOB',
  BOOLEAN:  'INTEGER',
  CITEXT:   'TEXT COLLATE NOCASE',
  DATE:     'TEXT',
  DATETIME: 'INTEGER',
  DECIMAL:  'NUMERIC',
  FLOAT:    'REAL',
  INTEGER:  'INTEGER',
  JSON:     'TEXT',
  SEQUENCE: 'INTEGER',
  STRING:   'TEXT',
  TEXT:     'TEXT',
  UUID:     'TEXT',
};

const identity: Codec = {
  encode: (value) => value,
  decode: (value) => value,
};

// integers are read as bigints (see `execute`), so those that aren't BIGINT
// columns go back to being numbers
const numeric: Codec = {
  encode: (value) => value,
  decode: (value: number | bigint) => Number(value),
};

const dialect: Dialect = {
  placeholder: () => '?',
  type: (col) => TYPES[col.type],
  generated: (col) => {
    if (col.type === 'SEQUENCE' && col.primaryKey) return 'AUTOINCREMENT';
    if (col.type === 'SEQUENCE') throw new Error(`SQLite can only generate sequences for primary keys, column "${col.name}" isn't one`);
    return undefined;
  },
  codecs: {
    BIGINT:   { encode: (value: bigint) => value, decode: (value: number | bigint) => BigInt(value) },
    BINARY:   identity,
    BOOLEAN:  { encode: (value: boolean) => (value ? 1 : 0), decode: (value: number | bigint) => Number(value) === 1 },
    CITEXT:   identity,
    DATE:     identity,
    DATETIME: { encode: (value: Date) => value.getTime(), decode: (value: number | bigint) => new Date(Number(value)) },
    DECIMAL:  numeric,
    FLOAT:    numeric,
    INTEGER:  numeric,
    JSON:     { encode: (value) => JSON.stringify(value), decode: (value: string) => JSON.parse(value) },
    SEQUENCE: numeric,
    STRING:   identity,
    TEXT:     identity,
    UUID:     identity,
  },
};

class BunSQLite implements IDatabase {
  readonly dialect = dialect;

  constructor(private readonly conn: Database,
              readonly loggers: ILogger[] = [],
              private readonly depth = 0) { }

  async execute(sql: string, params: unknown[]) {
    // without safe integers, bun:sqlite rounds anything beyond 2^53
    return this.conn.prepare(sql).safeIntegers(true).all(...(params as SQLQueryBindings[])) as Row[];
  }

  // bun:sqlite's own `transaction()` is synchronous and would commit before an
  // async callback settles, hence the manual BEGIN/COMMIT (SAVEPOINT if nested)
  async transaction<T>(fn: (tx: IDatabase) => Promise<T>) {
    const savepoint = `"sp_${this.depth}"`;
    const [begin, commit, rollback] = this.depth === 0
      ? ['BEGIN', 'COMMIT', 'ROLLBACK']
      : [`SAVEPOINT ${savepoint}`, `RELEASE ${savepoint}`, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`];

    this.conn.run(begin);

    try {
      const result = await fn(new BunSQLite(this.conn, this.loggers, this.depth + 1));
      this.conn.run(commit);
      return result;
    } catch (error) {
      this.conn.run(rollback);
      throw error;
    }
  }
}

const connect = (filename = ':memory:', { loggers = [] }: { loggers?: ILogger[] } = {}) => new BunSQLite(new Database(filename), loggers);

export {
  connect,
  dialect,
};
