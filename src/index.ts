import * as std from './standard-schema';
import { ValidationError } from './standard-schema';
import { type Expand, raise, snakeCase } from './utils';

// ─── columns ─────────────────────────────────────────────────────────────────

type Primitive =
  'BOOLEAN'
  | 'FLOAT'
  | 'INTEGER'
  | 'JSON'
  | 'STRING'
  | 'TIMESTAMP'
  | 'UUID';

type ColumnProps<S extends std.Schema = std.Schema> = {
  type: Primitive;
  schema: S;
  default?: unknown;
  generated?: true;
  nullable?: true;
  primaryKey?: true;
  unique?: true;
  fields?: Columns; // embedded fields, stored as JSON
  many?: true;      // a list of embedded objects, rather than one
};

type Column<K extends string = string, P extends ColumnProps = ColumnProps> = P & {
  key: K;                          // field name in TS land
  name: string;                    // column name in the database (snake_case)
  input: std.input<P['schema']>;   // type only
  output: std.output<P['schema']>; // type only
};

type Columns = Record<string, Column>;

class ColumnBuilder<P extends ColumnProps> {
  constructor(public readonly props: P) { }

  default(value: std.output<P['schema']> | (() => std.output<P['schema']>)) {
    return new ColumnBuilder({ ...this.props, default: value } as Expand<P & { default: typeof value }>);
  }

  generated() {
    if (this.props.type !== 'UUID') throw new Error('Only UUID columns can be generated');
    return new ColumnBuilder({ ...this.props, generated: true } as Expand<P & { generated: true }>);
  }

  // nullable in the database, and optional on insert
  optional() {
    if (this.props.primaryKey) throw new Error('Cannot make a primary key column optional');
    return new ColumnBuilder({ ...this.props, nullable: true } as unknown as Expand<Omit<P, 'schema'> & {
      nullable: true;
      schema: std.Schema<std.input<P['schema']> | null, std.output<P['schema']> | null>;
    }>);
  }

  primaryKey() {
    if (this.props.nullable) throw new Error('Cannot make an optional column a primary key');
    return new ColumnBuilder({ ...this.props, primaryKey: true } as Expand<P & { primaryKey: true }>);
  }

  unique() {
    if (this.props.primaryKey) throw new Error('Primary key columns are already unique');
    return new ColumnBuilder({ ...this.props, unique: true } as Expand<P & { unique: true }>);
  }

  unsigned(this: ColumnBuilder<P & { type: 'INTEGER' }>) {
    return new ColumnBuilder({ ...this.props, schema: std.integer({ min: 0 }) } as P);
  }
}

const column = <P extends ColumnProps>(props: P) => new ColumnBuilder(props);

type Shape = Record<string, ColumnBuilder<ColumnProps>>;

type ColumnsOfShape<S extends Shape> = {
  [K in keyof S & string]: Column<K, S[K]['props']>;
};

const columnsOfShape = (shape: Shape) => Object.fromEntries(
  Object.entries(shape).map(([key, { props }]) => [key, { ...props, key, name: snakeCase(key) } as Column]),
);

// embedded fields keep their keys as they are inside the JSON document
const fieldsOfShape = (shape: Shape) => Object.fromEntries(
  Object.entries(shape).map(([key, { props }]) => [key, { ...props, key, name: key } as Column]),
);

// validation happens field by field (see `check`), so the schema of an
// embedded column is only there for its types
const typed = <I, O>() => std.optional(std.string()) as unknown as std.Schema<I, O>;

const embedded = {
  one: <S extends Shape>(shape: S) => column({
    type: 'JSON',
    schema: typed<InferForInsert<ColumnsOfShape<S>>, InferForSelect<ColumnsOfShape<S>>>(),
    fields: fieldsOfShape(shape) as ColumnsOfShape<S>,
  }),
  many: <S extends Shape>(shape: S) => column({
    type: 'JSON',
    schema: typed<InferForInsert<ColumnsOfShape<S>>[], InferForSelect<ColumnsOfShape<S>>[]>(),
    fields: fieldsOfShape(shape) as ColumnsOfShape<S>,
    many: true,
  }),
};

// a column of a primitive type, validated by any standard schema
const defineType = <S extends std.Schema>({ primitive, schema }: { primitive: Exclude<Primitive, 'JSON'>, schema: S }) => column({ type: primitive, schema });

const types = {
  boolean: () => column({ type: 'BOOLEAN', schema: std.boolean() }),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => column({ type: 'STRING', schema: std.enumOf(values) }),
  float: () => column({ type: 'FLOAT', schema: std.number() }),
  integer: () => column({ type: 'INTEGER', schema: std.integer() }),
  record: () => column({ type: 'JSON', schema: std.record() }),
  string: ({ max }: { max?: number } = {}) => column({ type: 'STRING', schema: std.string({ max }) }),
  timestamp: () => column({ type: 'TIMESTAMP', schema: std.date() }),
  uuidv7: () => column({ type: 'UUID', schema: std.uuid() }),
};

// ─── validation ──────────────────────────────────────────────────────────────

type Issue = std.Schema.Issue;
type Path = std.Schema.Issue['path'] & {};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const defaultOf = (col: Column) => typeof col.default === 'function'
  ? col.default()
  : structuredClone(col.default);

// validates a column's value, filling in its defaults (embedded fields'
// included), and collects every issue rather than stopping at the first
const check = (col: Column, value: unknown, path: Path, issues: Issue[]): unknown => {
  if (value === undefined && 'default' in col) value = defaultOf(col);
  if (value === undefined && col.nullable) value = null;
  if (value === undefined) return void issues.push({ path, message: 'is required' });
  if (value === null) return col.nullable ? null : void issues.push({ path, message: 'must not be null' });

  if (col.fields && col.many) return Array.isArray(value)
    ? value.map((item, i) => checkObject(col.fields!, item, [...path, i], issues))
    : void issues.push({ path, message: 'must be an array' });

  if (col.fields) return checkObject(col.fields, value, path, issues);

  const parsed = std.parse(col.schema, value);
  if (parsed.issues) return void issues.push(...parsed.issues.map(issue => ({ ...issue, path: [...path, ...(issue.path ?? [])] })));

  return parsed.value;
};

// `partial` leaves missing keys out, rather than filling them in
const checkObject = (cols: Columns, value: unknown, path: Path, issues: Issue[], { partial = false } = {}) => {
  if (!isPlainObject(value)) return void issues.push({ path, message: 'must be an object' });

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(cols, key)) issues.push({ path: [...path, key], message: 'unknown field' });
  }

  const checked: Record<string, unknown> = {};

  for (const col of Object.values(cols)) {
    if (partial && value[col.key] === undefined) continue;
    checked[col.key] = check(col, value[col.key], [...path, col.key], issues);
  }

  return checked;
};

const validate = (cols: Columns, value: unknown, options: { partial?: boolean } = {}) => {
  const issues: Issue[] = [];
  const checked = checkObject(cols, value, [], issues, options);
  if (issues.length > 0) throw new ValidationError(issues);

  return checked!;
};

// ─── tables ──────────────────────────────────────────────────────────────────

const NAME = Symbol('exto.name');
const ALIAS = Symbol('exto.alias');
const NODE = Symbol('exto.node');
declare const COLUMNS: unique symbol;
declare const OPERAND: unique symbol;
declare const KEY: unique symbol;

type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'is' | 'is not';

// what an operand renders to: a column (or a field nested in one), a fragment
// of raw SQL, or an expression built from other nodes
type Node =
  | { kind: 'ref'; alias: string; col: Column; path: Column[] }
  | { kind: 'fragment'; strings: readonly string[]; values: unknown[] }
  | { kind: 'call'; fn: 'COUNT' | 'SUM'; arg: Node }
  | { kind: 'compare'; lhs: Node; op: Op; rhs: Node | { kind: 'value'; value: unknown } }
  | { kind: 'group'; op: 'AND' | 'OR'; nodes: Node[] };

// anything that renders to SQL. Type only: `aliases` are the tables it reads
// from, `value` is what it evaluates to, and `nulls` are the aliases whose
// missing rows turn it into null (in a left join)
type Operand<A extends string = string, V = unknown, N extends string = string> = {
  readonly [NODE]: Node;
  readonly [OPERAND]: { aliases: A; value: V; nulls: N };
};

type ColumnRef<A extends string = string, K extends string = string, V = unknown> = Operand<A, V, A> & {
  readonly [KEY]: K; // type only
};

// the fields of `embedded.one()` columns are referenced as properties of
// the column's reference, e.g. `tasks.payload.kind`
type FieldRefs<A extends string, C extends Column> = C extends { fields: infer F extends Columns }
  ? C extends { many: true } ? {} : { readonly [K in keyof F & string]: Operand<A, F[K]['output'], A> & FieldRefs<A, F[K]> }
  : {};

type RefTo<A extends string, K extends string, C extends Column> = ColumnRef<A, K, C['output']> & FieldRefs<A, C>;

type Table<N extends string = string, A extends string = string, C extends Columns = Columns> = {
  readonly [NAME]: N;
  readonly [ALIAS]: A;
  readonly [COLUMNS]: C; // type only
};

type ColumnsOf<T extends Table> = T[typeof COLUMNS];
type AliasOf<T extends Table> = T[typeof ALIAS];
type Keys<T extends Table> = keyof ColumnsOf<T> & string;

const isOperand = (value: unknown): value is Operand => typeof value === 'object' && value !== null && NODE in value;

const operand = (node: Node) => ({ [NODE]: node }) as unknown as Operand;

const refOf = (alias: string, col: Column, path: Column[] = []): Operand => {
  const leaf = path.at(-1) ?? col;
  const nested = leaf.fields && !leaf.many
    ? Object.values(leaf.fields).map(field => [field.key, refOf(alias, col, [...path, field])])
    : [];

  return Object.assign(operand({ kind: 'ref', alias, col, path }), Object.fromEntries(nested));
};

// a table is shaped like its columns: each enumerable property references a
// column under the table's alias, which is its name unless `as` says
// otherwise. The name and alias are symbols and `as` is non-enumerable, so
// spreading a table copies only its column references
const tableOf = (name: string, alias: string, columns: Column[]): Table => Object.defineProperties(
  Object.fromEntries(columns.map(col => [col.key, refOf(alias, col)])),
  {
    [NAME]: { value: name },
    [ALIAS]: { value: alias },
    as: { value: (alias: string) => tableOf(name, alias, columns) },
  },
) as unknown as Table;

const columnsOf = (table: Table) => (Object.values(table) as Operand[]).map(ref => (ref[NODE] as Node & { kind: 'ref' }).col);

const columnsByKey = (table: Table) => Object.fromEntries(columnsOf(table).map(col => [col.key, col]));

const columnOf = (table: Table, key: string) => columnsByKey(table)[key] ?? raise(`Unknown column "${key}" in table "${table[NAME]}"`);

type OmitOnInsert = { generated: true };
type OptionalOnInsert = { default: unknown } | { nullable: true };
type OmitOnUpdate = { generated: true } | { primaryKey: true };

type InferForSelect<C extends Columns> = Expand<{
  [K in keyof C]: C[K]['output'];
}>;

type InferForInsert<C extends Columns> = Expand<{
  [K in keyof C as C[K] extends OmitOnInsert | OptionalOnInsert ? never : K]: C[K]['input'];
} & {
  [K in keyof C as C[K] extends OmitOnInsert ? never : C[K] extends OptionalOnInsert ? K : never]?: C[K]['input'];
}>;

type InferForUpdate<C extends Columns> = Expand<{
  [K in keyof C as C[K] extends OmitOnUpdate ? never : K]?: C[K]['input'];
}>;

// a table's row (`select`), what `.values()` takes (`insert`), and what `set`
// takes (`update`)
type Infer<M extends 'select' | 'insert' | 'update', T extends Table> = {
  select: InferForSelect<ColumnsOf<T>>;
  insert: InferForInsert<ColumnsOf<T>>;
  update: InferForUpdate<ColumnsOf<T>>;
}[M];

type NumericKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends OmitOnUpdate ? never : C[K]['type'] extends 'INTEGER' | 'FLOAT' ? K : never;
}[keyof C];

// type only: TypeScript leaves class methods out of a spread's type, so
// declaring `as` as one keeps `{ ...table }` typed as just the columns, the
// way it is at runtime
declare class Aliasable<N extends string, C extends Columns> {
  as<B extends string>(alias: B): DefinedTable<N, B, C>;
}

type DefinedTable<N extends string, A extends string, C extends Columns> = Table<N, A, C> & {
  readonly [K in keyof C & string]: RefTo<A, K, C[K]>;
} & Aliasable<N, C>;

// `as` aliases the table
const RESERVED = ['as'] as const;

type Reserved<S> = { [K in keyof S & typeof RESERVED[number]]: never };

const defineTable = <N extends string, S extends Shape>(name: N, shape: S & NoInfer<Reserved<S>>) => {
  const columns = Object.values(columnsOfShape(shape));

  const reserved = columns.find(col => (RESERVED as readonly string[]).includes(col.key));
  if (reserved) throw new Error(`"${reserved.key}" is reserved, it can't be a column of table "${name}"`);

  return tableOf(name, name, columns) as unknown as DefinedTable<N, N, ColumnsOfShape<S>>;
};

// validates a row to be inserted into the table, filling in its defaults
const parse = <T extends Table>(table: T, input: unknown) => {
  const insertable = Object.fromEntries(columnsOf(table).filter(col => !col.generated).map(col => [col.key, col]));
  return validate(insertable, input) as Infer<'insert', T>;
};

// ─── adapter contract ────────────────────────────────────────────────────────

type Codec = {
  encode: (value: any) => unknown;
  decode: (value: any) => unknown;
};

// the built-in adapters' names; other adapters may name themselves anything
type DialectName = 'sqlite' | (string & {});

/**
 * Everything that differs between database engines. SQL generation, param
 * collection, validation and encoding/decoding all live in the core.
 *
 * `json` extracts a field nested in a JSON column: as an SQL value when
 * `text` is true, as a JSON document otherwise.
 */
interface Dialect {
  name: DialectName;
  placeholder(index: number): string;
  type(column: Column): string;
  json(sql: string, path: string[], text: boolean): string;
  codecs: Record<Primitive, Codec>;
}

interface ILogger {
  debug(sql: string, params: unknown[]): void;
  error(sql: string, params: unknown[], error: unknown): void;
}

type Row = Record<string, unknown>;

interface IDatabase {
  readonly dialect: Dialect;
  readonly loggers: ILogger[];
  execute(sql: string, params: unknown[]): Promise<Row[]>;
  transaction<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T>;
}

// ─── encoding ────────────────────────────────────────────────────────────────

// inside JSON documents, timestamps are ISO 8601 strings
const toJson = (col: Column, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (col.fields && col.many) return (value as Row[]).map(item => toJson({ ...col, many: undefined }, item));
  if (col.fields) return Object.fromEntries(Object.values(col.fields).map(field => [field.key, toJson(field, (value as Row)[field.key])]));
  if (col.type === 'TIMESTAMP') return (value as Date).toISOString();

  return value;
};

// databases may read JSON numbers as bigints and booleans as numbers
const fromJson = (col: Column, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (col.fields && col.many) return (value as Row[]).map(item => fromJson({ ...col, many: undefined }, item));
  if (col.fields) return Object.fromEntries(Object.values(col.fields).map(field => [field.key, fromJson(field, (value as Row)[field.key])]));
  if (col.type === 'TIMESTAMP') return new Date(value as string);
  if (col.type === 'INTEGER' || col.type === 'FLOAT') return Number(value);
  if (col.type === 'BOOLEAN') return value === true || value === 1 || value === 1n;

  return value;
};

const encode = (dialect: Dialect, col: Column, value: unknown) => value === null || value === undefined
  ? null
  : dialect.codecs[col.type].encode(col.type === 'JSON' ? toJson(col, value) : value);

const decode = (dialect: Dialect, col: Column, value: unknown) => value === null || value === undefined
  ? null
  : col.type === 'JSON' ? fromJson(col, dialect.codecs.JSON.decode(value)) : dialect.codecs[col.type].decode(value);

// ─── sql rendering ───────────────────────────────────────────────────────────

type Statement = { sql: string; params: unknown[] };

const quote = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

class SqlBuilder {
  private readonly frags: string[] = [];
  private readonly params: unknown[] = [];

  constructor(public readonly dialect: Dialect) { }

  push(...frags: string[]) {
    this.frags.push(...frags);
    return this;
  }

  param(value: unknown) {
    this.params.push(value);
    return this.push(this.dialect.placeholder(this.params.length));
  }

  join<T>(items: T[], separator: string, fn: (item: T) => unknown) {
    items.forEach((item, i) => {
      if (i > 0) this.push(separator);
      fn(item);
    });
    return this;
  }

  build(): Statement {
    return { sql: this.frags.join(''), params: this.params };
  }
}

const run = async (db: IDatabase, { sql, params }: Statement) => {
  db.loggers.forEach(logger => logger.debug(sql, params));

  try {
    return await db.execute(sql, params);
  } catch (error) {
    db.loggers.forEach(logger => logger.error(sql, params, error));
    throw error;
  }
};

// runs a raw statement, e.g. a data fix in a migration
const exec = async (db: IDatabase, sql: string, params: unknown[] = []) => {
  await run(db, { sql, params });
};

// ─── ddl ─────────────────────────────────────────────────────────────────────

const renderColumnDefinition = (dialect: Dialect, col: Column) => [
  quote(col.name),
  dialect.type(col),
  col.primaryKey && 'PRIMARY KEY',
  !col.nullable && 'NOT NULL',
  col.unique && 'UNIQUE',
].filter(Boolean).join(' ');

type IndexOptions = { ifNotExists?: boolean, name?: string };

const createIndex = <T extends Table>(table: T, keys: Keys<T>[], {
  ifNotExists = false,
  name,
  unique = false,
}: IndexOptions & { unique?: boolean } = {}) => ({
  onto: async (db: IDatabase) => {
    const cols = keys.map(key => columnOf(table, key).name);
    const index = name ?? `${table[NAME]}_${cols.join('_')}_index`;
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(index)} ON ${quote(table[NAME])} (${cols.map(quote).join(', ')})`;
    await run(db, { sql, params: [] });
  },
});

const create = {
  table: (table: Table, { ifNotExists = false }: { ifNotExists?: boolean } = {}) => ({
    onto: async (db: IDatabase) => {
      const cols = columnsOf(table).map(col => renderColumnDefinition(db.dialect, col));
      const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(table[NAME])} (${cols.join(', ')})`;
      await run(db, { sql, params: [] });
    },
  }),
  index: createIndex,
  uniqueIndex: <T extends Table>(table: T, keys: Keys<T>[], options: IndexOptions = {}) =>
    createIndex(table, keys, { ...options, unique: true }),
};

// ─── migrations ──────────────────────────────────────────────────────────────

const schemaMigrations = defineTable('schema_migrations', {
  id: types.string().primaryKey(),
  timestamp: types.timestamp(),
});

type Migration = (db: IDatabase) => Promise<void>;

// applies the pending migrations in the order of their ids, each in a
// transaction of its own, tracking the applied ones in `schema_migrations`
const defineMigrations = (migrations: Record<string, Migration>) => async (db: IDatabase) => {
  await create.table(schemaMigrations, { ifNotExists: true }).onto(db);

  const { dialect } = db;
  const rows = await run(db, { sql: 'SELECT "id" FROM "schema_migrations"', params: [] });
  const applied = new Set(rows.map(row => row['id']));

  for (const id of Object.keys(migrations).sort()) {
    if (applied.has(id)) continue;

    await db.transaction(async tx => {
      await migrations[id]!(tx);
      await run(tx, {
        sql: `INSERT INTO "schema_migrations" ("id", "timestamp") VALUES (${dialect.placeholder(1)}, ${dialect.placeholder(2)})`,
        params: [id, encode(dialect, columnOf(schemaMigrations, 'timestamp'), new Date())],
      });
    });
  }
};

export {
  type Codec,
  type Column,
  type ColumnProps,
  type ColumnRef,
  type Dialect,
  type DialectName,
  type IDatabase,
  type ILogger,
  type Infer,
  type Migration,
  type Operand,
  type Primitive,
  type Row,
  type Table,
  ValidationError,
  column,
  create,
  defineMigrations,
  defineTable as table,
  defineType,
  embedded,
  exec,
  parse,
  types as t,
};
