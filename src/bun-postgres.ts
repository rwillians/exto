import { SQL, type TransactionSQL } from 'bun';
import type { Codec, Column, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, (col: Column) => string> = {
  BIGINT:    () => 'BIGINT',
  BINARY:    () => 'BYTEA',
  BOOLEAN:   () => 'BOOLEAN',
  CITEXT:    () => 'CITEXT',
  DATE:      () => 'DATE',
  DECIMAL:   ({ precision, scale }) => precision !== undefined && scale !== undefined ? `NUMERIC(${precision}, ${scale})` : 'NUMERIC',
  FLOAT:     () => 'DOUBLE PRECISION',
  INTEGER:   () => 'BIGINT',
  JSON:      () => 'JSONB',
  SEQUENCE:  () => 'BIGINT',
  STRING:    ({ length = 255 }) => `VARCHAR(${length})`,
  TEXT:      () => 'TEXT',
  TIMESTAMP: () => 'TIMESTAMPTZ',
  UUID:      () => 'UUID',
};

const identity = <T>() => ({
  encode: (value: T) => value,
  decode: (value: T) => value,
});

// Bun.SQL reads bigints (BIGINT columns, COUNT and SUM) and NUMERICs as
// strings
const numeric: Codec = {
  encode: (value: number) => value,
  decode: (value: string | number) => Number(value),
};

// `#>>` reads text, so fields of other types are cast back to theirs
const CASTS: Partial<Record<Primitive, string>> = {
  BIGINT:   'BIGINT',
  BOOLEAN:  'BOOLEAN',
  DECIMAL:  'NUMERIC',
  FLOAT:    'DOUBLE PRECISION',
  INTEGER:  'DOUBLE PRECISION',
  SEQUENCE: 'BIGINT',
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
  type: (col) => TYPES[col.type](col),
  generated: (col) => col.type === 'SEQUENCE'
    ? 'GENERATED ALWAYS AS IDENTITY'
    : undefined,
  json,
  operators: {},
  codecs: {
    BIGINT:    { encode: (value: bigint) => value, decode: (value: string | bigint) => BigInt(value) },
    BINARY:    { encode: (value: Uint8Array) => value, decode: (value: Uint8Array) => new Uint8Array(value) },
    BOOLEAN:   identity<boolean>(),
    CITEXT:    identity<string>(),
    DATE:      { encode: (value: string) => value, decode: (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : value },
    DECIMAL:   numeric,
    FLOAT:     numeric,
    INTEGER:   numeric,
    JSON:      identity<unknown>(),
    SEQUENCE:  numeric,
    STRING:    identity<string>(),
    TEXT:      identity<string>(),
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
