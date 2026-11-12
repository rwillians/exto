import { SQL, type TransactionSQL } from 'bun';
import type { Codec, Column, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, (col: Column) => string> = {
  BINARY:   () => 'BYTEA',
  BOOLEAN:  () => 'BOOLEAN',
  DATE:     () => 'DATE',
  DATETIME: () => 'TIMESTAMPTZ',
  DECIMAL:  () => 'NUMERIC',
  FLOAT:    () => 'DOUBLE PRECISION',
  INTEGER:  () => 'BIGINT',
  JSON:     () => 'JSONB',
  SEQUENCE: () => 'BIGINT',
  STRING:   (col) => `VARCHAR(${col.length})`,
  TEXT:     () => 'TEXT',
  UUID:     () => 'UUID',
};

const identity: Codec = {
  encode: (value) => value,
  decode: (value) => value,
};

const dialect: Dialect = {
  placeholder: (index) => `$${index}`,
  type: (col) => TYPES[col.type](col),
  generated: (col) => col.type === 'SEQUENCE'
    ? 'GENERATED ALWAYS AS IDENTITY'
    : undefined,
  codecs: {
    BINARY:   identity,
    BOOLEAN:  identity,
    DATE:     { encode: (value: string) => value, decode: (value: Date | string) => value instanceof Date ? value.toISOString().slice(0, 10) : value },
    DATETIME: identity,
    DECIMAL:  { encode: (value: number) => value, decode: (value: string) => Number(value) },
    FLOAT:    identity,
    INTEGER:  { encode: (value: number) => value, decode: (value: string | bigint | number) => Number(value) },
    JSON:     identity,
    SEQUENCE: { encode: (value: number) => value, decode: (value: string | bigint | number) => Number(value) },
    STRING:   identity,
    TEXT:     identity,
    UUID:     identity,
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
