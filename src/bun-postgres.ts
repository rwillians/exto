import { SQL, type TransactionSQL } from 'bun';
import type { Codec, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, string> = {
  BOOLEAN:   'BOOLEAN',
  FLOAT:     'DOUBLE PRECISION',
  INTEGER:   'BIGINT',
  JSON:      'JSONB',
  STRING:    'TEXT',
  TIMESTAMP: 'TIMESTAMPTZ',
  UUID:      'UUID',
};

const identity = <T>() => ({
  encode: (value: T) => value,
  decode: (value: T) => value,
});

// Bun.SQL reads bigints (BIGINT columns, COUNT and SUM) as strings
const numeric: Codec = {
  encode: (value: number) => value,
  decode: (value: string | number) => Number(value),
};

// `#>>` reads text, so fields of other types are cast back to theirs
const CASTS: Partial<Record<Primitive, string>> = {
  BOOLEAN: 'BOOLEAN',
  FLOAT:   'DOUBLE PRECISION',
  INTEGER: 'DOUBLE PRECISION',
};

const jsonPath = (path: string[]) => `'{${path.map(key => `"${key.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\'', '\'\'')}"`).join(',')}}'`;

const json = (sql: string, path: string[], type: Primitive) => {
  if (type === 'JSON') return `${sql} #> ${jsonPath(path)}`;

  const text = `${sql} #>> ${jsonPath(path)}`;
  return CASTS[type] ? `(${text})::${CASTS[type]}` : text;
};

// Bun.SQL sends objects and arrays as JSON, and reads JSONB already parsed
const dialect: Dialect = {
  name: 'postgres',
  placeholder: (index) => `$${index}`,
  type: (col) => TYPES[col.type],
  json,
  codecs: {
    BOOLEAN:   identity<boolean>(),
    FLOAT:     numeric,
    INTEGER:   numeric,
    JSON:      identity<unknown>(),
    STRING:    identity<string>(),
    TIMESTAMP: { encode: (value: Date) => value, decode: (value: Date | string) => new Date(value) },
    UUID:      identity<string>(),
  },
};

class BunPostgres implements IDatabase {
  readonly dialect = dialect;

  constructor(private readonly sql: SQL,
              readonly loggers: ILogger[] = [],
              private readonly inTransaction = false) { }

  async execute(sql: string, params: unknown[]) {
    return await this.sql.unsafe<Row[]>(sql, params);
  }

  async close() {
    await this.sql.close();
  }

  // nested transactions are savepoints of the outer one
  async transaction<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> {
    const callback = (tx: SQL): Promise<T> => fn(new BunPostgres(tx, this.loggers, true));
    const result = this.inTransaction
      ? (this.sql as TransactionSQL).savepoint(callback)
      : this.sql.begin(callback);

    return await result as T;
  }
}

const connect = (url: string, { loggers = [] }: { loggers?: ILogger[] } = {}) => new BunPostgres(new SQL(url), loggers);

export {
  connect,
  dialect,
};
