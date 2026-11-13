import * as std from './standard-schema';
import { ValidationError } from './standard-schema';
import { type CamelCase, type Expand, camelCase, snakeCase, wrap } from './utils';

// ─── columns ─────────────────────────────────────────────────────────────────

type Primitive =
  'BINARY'
  | 'BOOLEAN'
  | 'DATE'
  | 'DATETIME'
  | 'DECIMAL'
  | 'FLOAT'
  | 'INTEGER'
  | 'JSON'
  | 'SEQUENCE'
  | 'STRING'
  | 'TEXT'
  | 'UUID';

type ColumnProps<S extends std.Schema = std.Schema> = {
  type: Primitive;
  schema: S;
  default?: unknown;
  generated?: true;
  length?: number;
  nullable?: true;
  primaryKey?: true;
  unique?: true;
};

type Column<K extends string = string, P extends ColumnProps = ColumnProps> = P & {
  key: K;                        // field name in TS land (camelCase)
  name: string;                  // column name in the database (snake_case)
  input: std.input<P['schema']>;   // type only
  output: std.output<P['schema']>; // type only
};

class ColumnBuilder<P extends ColumnProps> {
  constructor(public readonly props: P) { }

  default(value: std.output<P['schema']> | (() => std.output<P['schema']>)) {
    return new ColumnBuilder({ ...this.props, default: value } as Expand<P & { default: typeof value }>);
  }

  generated() {
    if (this.props.type !== 'UUID') throw new Error('Only UUID columns can be generated, use t.sequence() for integers');
    return new ColumnBuilder({ ...this.props, generated: true } as Expand<P & { generated: true }>);
  }

  nullable() {
    if (this.props.primaryKey) throw new Error('Cannot make a primary key column nullable');
    return new ColumnBuilder({ ...this.props, nullable: true, schema: std.nullable(this.props.schema) } as unknown as Expand<Omit<P, 'schema'> & {
      nullable: true;
      schema: std.Schema<std.input<P['schema']> | null, std.output<P['schema']> | null>;
    }>);
  }

  primaryKey() {
    if (this.props.nullable) throw new Error('Cannot make a nullable column a primary key');
    return new ColumnBuilder({ ...this.props, primaryKey: true } as Expand<P & { primaryKey: true }>);
  }

  unique() {
    if (this.props.primaryKey) throw new Error('Primary key columns are already unique');
    return new ColumnBuilder({ ...this.props, unique: true } as Expand<P & { unique: true }>);
  }
}

const column = <P extends ColumnProps>(props: P) => new ColumnBuilder(props);

const types = {
  binary: () => column({ type: 'BINARY', schema: std.instanceOf(Uint8Array) }),
  boolean: () => column({ type: 'BOOLEAN', schema: std.boolean() }),
  date: () => column({ type: 'DATE', schema: std.isoDate() }),
  datetime: () => column({ type: 'DATETIME', schema: std.date() }),
  decimal: () => column({ type: 'DECIMAL', schema: std.number() }),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => column({
    type: 'STRING',
    schema: std.enumOf(values),
    length: Math.max(...values.map(value => value.length)),
  }),
  float: () => column({ type: 'FLOAT', schema: std.number() }),
  integer: () => column({ type: 'INTEGER', schema: std.integer() }),
  json: <S extends std.Schema>(schema: S) => column({ type: 'JSON', schema }),
  sequence: () => column({ type: 'SEQUENCE', schema: std.integer(), generated: true }),
  string: ({ size = 255 }: { size?: number } = {}) => column({ type: 'STRING', schema: std.string({ max: size }), length: size }),
  text: () => column({ type: 'TEXT', schema: std.string() }),
  uuid: () => column({ type: 'UUID', schema: std.uuid() }),
};

// ─── tables ──────────────────────────────────────────────────────────────────

type Columns = Record<string, Column>;

type Table<N extends string = string, C extends Columns = Columns> = {
  name: N;
  alias: string;
  columns: C;
};

type OmitOnInsert = { generated: true };
type OptionalOnInsert = { default: unknown } | { nullable: true };
type OmitOnUpdate = { generated: true } | { primaryKey: true };
type NumericType = 'DECIMAL' | 'FLOAT' | 'INTEGER';

type Infer<C extends Columns> = Expand<{
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

type NumericKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends OmitOnUpdate ? never : C[K]['type'] extends NumericType ? K : never;
}[keyof C];

type DefinedTable<N extends string, C extends Columns> = Table<N, C> & {
  as: (alias: string) => DefinedTable<N, C>;
  infer: Infer<C>;                   // type only
  inferForInsert: InferForInsert<C>; // type only
  inferForUpdate: InferForUpdate<C>; // type only
};

const defineTable = <
  N extends string,
  S extends Record<string, ColumnBuilder<ColumnProps>>,
>(name: N, shapeFn: (t: typeof types) => S) => {
  const columns = Object.fromEntries(
    Object
      .entries(shapeFn(types))
      .map(([key, { props }]) => [camelCase(key), { ...props, key: camelCase(key), name: snakeCase(camelCase(key)) }] as const),
  );

  const aliased = (alias: string) => ({ name, alias, columns, as: aliased });

  return aliased(name) as unknown as DefinedTable<N, {
    [K in keyof S & string as CamelCase<K>]: Column<CamelCase<K>, S[K]['props']>;
  }>;
};

const columnOf = (table: Table, key: string) => {
  const col = table.columns[key];
  if (!col) throw new Error(`Unknown column "${key}" in table "${table.name}"`);
  return col;
};

// ─── adapter contract ────────────────────────────────────────────────────────

type Codec = {
  encode: (value: any) => unknown;
  decode: (value: any) => unknown;
};

/**
 * Everything that differs between database engines. SQL generation, param
 * collection, validation and encoding/decoding all live in the core.
 *
 * `generated` returns the DDL that makes the database generate the column's
 * value, or `undefined` when the database can't natively, in which case the
 * value is generated client-side on insert.
 */
interface Dialect {
  placeholder(index: number): string;
  type(column: Column): string;
  generated(column: Column): string | undefined;
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

// ─── sql rendering ───────────────────────────────────────────────────────────

type Statement = { sql: string; params: unknown[] };

const quote = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

const ref = (col: Column, qualifier?: string) => qualifier
  ? `${quote(qualifier)}.${quote(col.name)}`
  : quote(col.name);

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

const encode = (dialect: Dialect, col: Column, value: unknown) => value === null || value === undefined
  ? null
  : dialect.codecs[col.type].encode(value);

const decode = (dialect: Dialect, col: Column, value: unknown) => value === null || value === undefined
  ? null
  : dialect.codecs[col.type].decode(value);

const decoder = (dialect: Dialect, cols: Column[]) => (row: Row) => Object.fromEntries(
  cols.map(col => [col.key, decode(dialect, col, row[col.key])] as const),
);

const run = async (db: IDatabase, { sql, params }: Statement) => {
  db.loggers.forEach(logger => logger.debug(sql, params));

  try {
    return await db.execute(sql, params);
  } catch (error) {
    db.loggers.forEach(logger => logger.error(sql, params, error));
    throw error;
  }
};

const renderReturning = (b: SqlBuilder, cols: Column[]) => b
  .push(' RETURNING ')
  .join(cols, ', ', col => b.push(ref(col), ' AS ', quote(col.key)));

// ─── where ───────────────────────────────────────────────────────────────────

type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'not like' | 'in' | 'not in' | 'is' | 'is not';

type ValueFor<V, O extends Op> =
  O extends 'is' | 'is not' ? null
  : O extends 'in' | 'not in' ? NonNullable<V>[]
  : O extends 'like' | 'not like' ? string
  : NonNullable<V>;

type Condition = { col: Column; op: Op; value: unknown };

const renderCondition = (b: SqlBuilder, qualifier?: string) => ({ col, op, value }: Condition) => {
  if (op === 'is' || op === 'is not') return b.push(ref(col, qualifier), ' ', op.toUpperCase(), ' NULL');
  if (op !== 'in' && op !== 'not in') return b.push(ref(col, qualifier), ' ', op.toUpperCase(), ' ').param(encode(b.dialect, col, value));

  const values = value as unknown[];
  if (values.length === 0) return b.push(op === 'in' ? '1 = 0' : '1 = 1');

  return b
    .push(ref(col, qualifier), ' ', op.toUpperCase(), ' (')
    .join(values, ', ', v => b.param(encode(b.dialect, col, v)))
    .push(')');
};

const renderWhere = (b: SqlBuilder, conditions: Condition[], qualifier?: string) => conditions.length === 0
  ? b
  : b.push(' WHERE ').join(conditions, ' AND ', renderCondition(b, qualifier));

// ─── insert ──────────────────────────────────────────────────────────────────

const CLIENT_GENERATORS: Partial<Record<Primitive, () => unknown>> = {
  UUID: () => Bun.randomUUIDv7(),
};

const isGeneratedByClient = (dialect: Dialect, col: Column) => col.generated === true && dialect.generated(col) === undefined;

const resolveInsertValue = (col: Column, row: Row) => {
  if (col.generated) {
    const generate = CLIENT_GENERATORS[col.type];
    if (!generate) throw new Error(`Cannot generate a value for column "${col.name}" client-side`);
    return generate();
  }

  if (row[col.key] !== undefined) return row[col.key];
  if ('default' in col) return typeof col.default === 'function' ? col.default() : col.default;
  if (col.nullable) return null;
  return undefined;
};

class InsertBuilder<T extends Table> {
  constructor(private readonly table: T,
              private readonly rows: InferForInsert<T['columns']>[] = []) { }

  values(rows: InferForInsert<T['columns']> | InferForInsert<T['columns']>[]) {
    return new InsertBuilder(this.table, [...this.rows, ...wrap(rows)]);
  }

  insert(db: IDatabase): Promise<Infer<T['columns']>[]>;
  insert(db: IDatabase, options: { returning: false }): Promise<undefined>;
  insert<K extends keyof T['columns'] & string>(db: IDatabase, options: { returning: K[] }): Promise<Expand<Pick<Infer<T['columns']>, K>>[]>;
  async insert(db: IDatabase, { returning }: { returning?: string[] | false } = {}) {
    if (this.rows.length === 0) return returning === false ? undefined : [];

    const cols = Object.values(this.table.columns);
    const insertable = cols.filter(col => !col.generated || isGeneratedByClient(db.dialect, col));
    const schema = std.array(std.strictObject(Object.fromEntries(insertable.map(col => [col.key, col.schema]))));

    const rows = std.parseOrThrow(schema, this.rows.map(row => ({
      ...row,
      ...Object.fromEntries(insertable.map(col => [col.key, resolveInsertValue(col, row)])),
    })));

    const b = new SqlBuilder(db.dialect)
      .push('INSERT INTO ', quote(this.table.name), ' (', insertable.map(col => quote(col.name)).join(', '), ') VALUES ');

    b.join(rows, ', ', row => b
      .push('(')
      .join(insertable, ', ', col => b.param(encode(db.dialect, col, row[col.key])))
      .push(')'));

    // an empty RETURNING isn't valid SQL; every row is inserted (or it throws),
    // so `returning: []` gets one empty object per row without asking the db
    if (returning === false || returning?.length === 0) {
      await run(db, b.build());
      return returning === false ? undefined : rows.map(() => ({}));
    }

    const returned = returning ? returning.map(key => columnOf(this.table, key)) : cols;
    const results = await run(db, renderReturning(b, returned).build());
    return results.map(decoder(db.dialect, returned));
  }
}

const into = <T extends Table>(table: T) => new InsertBuilder(table);

// ─── query ───────────────────────────────────────────────────────────────────

type Direction = 'ASC' | 'DESC';

type Query<T extends Table> = {
  table: T;
  where: Condition[];
  orderBy: [Column, Direction][];
  limit?: number;
  offset?: number;
};

type Changes<C extends Columns> = {
  set?: InferForUpdate<C>;
  inc?: { [K in NumericKeys<C>]?: number };
};

class QueryBuilder<T extends Table> {
  constructor(private readonly query: Query<T>) { }

  where<K extends keyof T['columns'] & string, O extends Op>(key: K, op: O, value: ValueFor<T['columns'][K]['output'], O>) {
    const condition = { col: columnOf(this.query.table, key), op, value };
    return new QueryBuilder({ ...this.query, where: [...this.query.where, condition] });
  }

  orderBy(keys: (keyof T['columns'] & string | [keyof T['columns'] & string, Direction])[]) {
    const orderBy = keys.map(key => typeof key === 'string'
      ? [columnOf(this.query.table, key), 'ASC'] as [Column, Direction]
      : [columnOf(this.query.table, key[0]), key[1]] as [Column, Direction]);

    return new QueryBuilder({ ...this.query, orderBy: [...this.query.orderBy, ...orderBy] });
  }

  limit(n: number) {
    return new QueryBuilder({ ...this.query, limit: n });
  }

  offset(n: number) {
    return new QueryBuilder({ ...this.query, offset: n });
  }

  async select<K extends keyof T['columns'] & string = keyof T['columns'] & string>(db: IDatabase, keys?: K[]) {
    const { table, where, orderBy, limit, offset } = this.query;
    const cols = keys
      ? keys.map(key => columnOf(table, key))
      : Object.values(table.columns);

    const b = new SqlBuilder(db.dialect).push('SELECT ');

    b.join(cols, ', ', col => b.push(ref(col, table.alias), ' AS ', quote(col.key)))
      .push(' FROM ', quote(table.name), ' AS ', quote(table.alias));

    renderWhere(b, where, table.alias);
    if (orderBy.length > 0) b.push(' ORDER BY ').join(orderBy, ', ', ([col, dir]) => b.push(ref(col, table.alias), ' ', dir));
    // sqlite requires LIMIT whenever there's an OFFSET, and there's no "no
    // limit" value both sqlite and postgres accept other than a huge number
    if (limit !== undefined || offset !== undefined) b.push(' LIMIT ').param(limit ?? Number.MAX_SAFE_INTEGER);
    if (offset !== undefined) b.push(' OFFSET ').param(offset);

    const rows = await run(db, b.build());
    return rows.map(decoder(db.dialect, cols)) as Expand<Pick<Infer<T['columns']>, K>>[];
  }

  async update(db: IDatabase, changes: Changes<T['columns']>) {
    this.assertUnbounded('update');

    const { table, where } = this.query;
    const cols = Object.values(table.columns);
    const updatable = cols.filter(col => !col.generated && !col.primaryKey);
    const numeric = updatable.filter(col => ['DECIMAL', 'FLOAT', 'INTEGER'].includes(col.type));

    const set = std.parseOrThrow(std.strictObject(Object.fromEntries(updatable.map(col => [col.key, std.optional(col.schema)]))), changes.set ?? {});
    const inc = std.parseOrThrow(std.strictObject(Object.fromEntries(numeric.map(col => [col.key, std.optional(std.number())]))), changes.inc ?? {});

    const assignments = [
      ...Object.entries(set).filter(([, value]) => value !== undefined).map(([key, value]) => ({ col: columnOf(table, key), value, inc: false })),
      ...Object.entries(inc).filter(([, value]) => value !== undefined).map(([key, value]) => ({ col: columnOf(table, key), value, inc: true })),
    ];

    if (assignments.length === 0) throw new Error('Nothing to update: both `set` and `inc` are empty');

    const b = new SqlBuilder(db.dialect).push('UPDATE ', quote(table.name), ' SET ');

    b.join(assignments, ', ', ({ col, value, inc }) => inc
      ? b.push(ref(col), ' = ', ref(col), ' + ').param(value)
      : b.push(ref(col), ' = ').param(encode(db.dialect, col, value)));

    renderWhere(b, where);

    const rows = await run(db, renderReturning(b, cols).build());
    return rows.map(decoder(db.dialect, cols)) as Infer<T['columns']>[];
  }

  async delete(db: IDatabase) {
    this.assertUnbounded('delete');

    const { table, where } = this.query;
    const cols = Object.values(table.columns);
    const b = new SqlBuilder(db.dialect).push('DELETE FROM ', quote(table.name));

    renderWhere(b, where);

    const rows = await run(db, renderReturning(b, cols).build());
    return rows.map(decoder(db.dialect, cols)) as Infer<T['columns']>[];
  }

  // UPDATE/DELETE ... ORDER BY/LIMIT isn't portable, so refuse it rather than
  // silently affecting more rows than the query suggests
  private assertUnbounded(operation: string) {
    const { orderBy, limit, offset } = this.query;
    if (orderBy.length > 0 || limit !== undefined || offset !== undefined) {
      throw new Error(`Cannot ${operation} with orderBy, limit or offset`);
    }
  }
}

const from = <T extends Table>(table: T) => new QueryBuilder({ table, where: [], orderBy: [] });

// ─── ddl ─────────────────────────────────────────────────────────────────────

const renderColumnDefinition = (dialect: Dialect, col: Column) => [
  quote(col.name),
  dialect.type(col),
  col.primaryKey && 'PRIMARY KEY',
  col.generated && dialect.generated(col),
  !col.nullable && 'NOT NULL',
  col.unique && 'UNIQUE',
].filter(Boolean).join(' ');

const create = {
  table: (table: Table, { ifNotExists = false }: { ifNotExists?: boolean } = {}) => ({
    onto: async (db: IDatabase) => {
      const cols = Object.values(table.columns).map(col => renderColumnDefinition(db.dialect, col));
      const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(table.name)} (${cols.join(', ')})`;
      await run(db, { sql, params: [] });
    },
  }),
  index: <T extends Table>(table: T, keys: (keyof T['columns'] & string)[], {
    ifNotExists = false,
    name,
    unique = false,
  }: { ifNotExists?: boolean, name?: string, unique?: boolean } = {}) => ({
    onto: async (db: IDatabase) => {
      const cols = keys.map(key => columnOf(table, key).name);
      const index = name ?? `${table.name}_${cols.join('_')}_index`;
      const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(index)} ON ${quote(table.name)} (${cols.map(quote).join(', ')})`;
      await run(db, { sql, params: [] });
    },
  }),
};

// ─── migrations ──────────────────────────────────────────────────────────────

const schemaMigrations = defineTable('schema_migrations', t => ({
  id: t.string().primaryKey(),
  migratedAt: t.datetime(),
}));

type Migration = (db: IDatabase) => Promise<void>;

const defineMigrations = (migrations: Record<string, Migration>) => async (db: IDatabase) => {
  await create.table(schemaMigrations, { ifNotExists: true }).onto(db);

  const applied = new Set((await from(schemaMigrations).select(db, ['id'])).map(row => row.id));

  for (const id of Object.keys(migrations).sort()) {
    if (applied.has(id)) continue;

    await db.transaction(async tx => {
      await migrations[id]!(tx);
      await into(schemaMigrations).values({ id, migratedAt: new Date() }).insert(tx);
    });
  }
};

export {
  type Codec,
  type Column,
  type ColumnProps,
  type Dialect,
  type IDatabase,
  type ILogger,
  type Migration,
  type Primitive,
  type Row,
  type Table,
  ValidationError,
  column,
  create,
  defineMigrations,
  defineTable as table,
  from,
  into,
  types as t,
};
