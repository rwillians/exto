import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { Codec, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, string> = {
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

const dialect: Dialect = {
  placeholder: () => '?',
  type: (col) => TYPES[col.type],
  generated: (col) => {
    if (col.type === 'SEQUENCE' && col.primaryKey) return 'AUTOINCREMENT';
    if (col.type === 'SEQUENCE') throw new Error(`SQLite can only generate sequences for primary keys, column "${col.name}" isn't one`);
    return undefined;
  },
  codecs: {
    BINARY:   identity,
    BOOLEAN:  { encode: (value: boolean) => (value ? 1 : 0), decode: (value: number) => value === 1 },
    CITEXT:   identity,
    DATE:     identity,
    DATETIME: { encode: (value: Date) => value.getTime(), decode: (value: number) => new Date(value) },
    DECIMAL:  identity,
    FLOAT:    identity,
    INTEGER:  identity,
    JSON:     { encode: (value) => JSON.stringify(value), decode: (value: string) => JSON.parse(value) },
    SEQUENCE: identity,
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
    return this.conn.prepare(sql).all(...(params as SQLQueryBindings[])) as Row[];
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
