import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { Codec, Dialect, IDatabase, ILogger, Primitive, Row } from './index';

const TYPES: Record<Primitive, string> = {
  BIGINT:    'INTEGER',
  BINARY:    'BLOB',
  BOOLEAN:   'INTEGER',
  CITEXT:    'TEXT COLLATE NOCASE',
  DATE:      'TEXT',
  DECIMAL:   'NUMERIC',
  FLOAT:     'REAL',
  INTEGER:   'INTEGER',
  JSON:      'TEXT',
  SEQUENCE:  'INTEGER',
  STRING:    'TEXT',
  TEXT:      'TEXT',
  TIMESTAMP: 'INTEGER',
  UUID:      'TEXT',
};

const identity = <T>() => ({
  encode: (value: T) => value,
  decode: (value: T) => value,
});

// integers are read as bigints (see `execute`), so those that aren't BIGINT
// columns go back to being numbers
const numeric: Codec = {
  encode: (value: number) => value,
  decode: (value: number | bigint) => Number(value),
};

// sqlite's JSON paths quote each key, so that any key is a valid one
const jsonPath = (path: string[]) => `'$${path.map(key => `."${key.replaceAll('"', '\\"').replaceAll('\'', '\'\'')}"`).join('')}'`;

const literal = (str: string) => `'${str.replaceAll('\'', '\'\'')}'`;

// how columns read inside a JSON document: JSON columns as documents, and
// bigints and binaries as strings, which JSON can't hold otherwise
const jsonOf = (sql: string, type: Primitive) => {
  if (type === 'JSON') return `json(${sql})`;
  if (type === 'BIGINT') return `CAST(${sql} AS TEXT)`;
  if (type === 'BINARY') return `CASE WHEN ${sql} IS NULL THEN NULL ELSE lower(hex(${sql})) END`;
  return sql;
};

const dialect: Dialect = {
  name: 'sqlite',
  placeholder: () => '?',
  type: (col) => TYPES[col.type],
  generated: (col) => {
    if (col.type === 'SEQUENCE' && col.primaryKey) return 'AUTOINCREMENT';
    if (col.type === 'SEQUENCE') throw new Error(`SQLite can only generate sequences for primary keys, column "${col.name}" isn't one`);
    return undefined;
  },
  // LIKE already ignores the case of ASCII letters
  operators: { 'ILIKE': 'LIKE', 'NOT ILIKE': 'NOT LIKE' },
  jsonOf,
  // see `connect` for REGEXP and regexp_like(), which match the way JavaScript
  // does. Flags are a literal, from a closed set of letters
  match: (sql, pattern, regex) => regex.flags
    ? `regexp_like(${sql}, ${pattern}, '${regex.flags}')`
    : `${sql} REGEXP ${pattern}`,
  collect: (entries, filter) => {
    const object = `json_object(${entries.map(([key, sql]) => `${literal(key)}, ${sql}`).join(', ')})`;
    return `json_group_array(${object})${filter ? ` FILTER (WHERE ${filter})` : ''}`;
  },
  json: (sql, path, type) => `${sql} ${type === 'JSON' ? '->' : '->>'} ${jsonPath(path)}`,
  codecs: {
    BIGINT:    { encode: (value: bigint) => value, decode: (value: number | bigint) => BigInt(value) },
    BINARY:    { encode: (value: Uint8Array) => value, decode: (value: Uint8Array) => new Uint8Array(value) },
    BOOLEAN:   { encode: (value: boolean) => (value ? 1 : 0), decode: (value: number | bigint) => Number(value) === 1 },
    CITEXT:    identity<string>(),
    DATE:      identity<string>(),
    DECIMAL:   numeric,
    FLOAT:     numeric,
    INTEGER:   numeric,
    JSON:      { encode: (value) => JSON.stringify(value), decode: (value: string) => JSON.parse(value) },
    SEQUENCE:  numeric,
    STRING:    identity<string>(),
    TEXT:      identity<string>(),
    TIMESTAMP: { encode: (value: Date) => value.getTime(), decode: (value: number | bigint) => new Date(Number(value)) },
    UUID:      identity<string>(),
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

  async close() {
    this.conn.close();
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

// whether text matches a pattern, null when either is
const matches = (text: unknown, pattern: string | null, flags = '') => text === null || pattern === null
  ? null
  : new RegExp(pattern, flags).test(String(text));

// sqlite has the REGEXP operator, but no function behind it: `X REGEXP Y`
// calls `regexp(Y, X)`. regexp_like() also takes flags, the way it does on
// other databases
const connect = (filename = ':memory:', { loggers = [] }: { loggers?: ILogger[] } = {}) => {
  const conn = new Database(filename)
    .function('regexp', { deterministic: true }, (pattern: string | null, text: unknown) => matches(text, pattern))
    .function('regexp_like', { deterministic: true }, (text: unknown, pattern: string | null) => matches(text, pattern))
    .function('regexp_like', { deterministic: true }, (text: unknown, pattern: string | null, flags: string) => matches(text, pattern, flags));

  return new BunSQLite(conn, loggers);
};

export {
  connect,
  dialect,
};
