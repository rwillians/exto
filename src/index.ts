import * as std from './standard-schema';
import { ValidationError } from './standard-schema';
import { type CamelCase, type Expand, camelCase, snakeCase, wrap } from './utils';

// ─── columns ─────────────────────────────────────────────────────────────────

type Primitive =
  'BINARY'
  | 'BOOLEAN'
  | 'CITEXT'
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
  // case-insensitive text; postgres needs `CREATE EXTENSION citext` for it
  citext: () => column({ type: 'CITEXT', schema: std.string() }),
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

// runs a raw statement, e.g. `CREATE EXTENSION` in a migration
const exec = async (db: IDatabase, sql: string, params: unknown[] = []) => {
  await run(db, { sql, params });
};

// `true` returns every field, a list returns those fields, `false` returns
// nothing at all
type Returning = boolean | string[];

const runReturning = async (db: IDatabase, b: SqlBuilder, table: Table, returning: Returning) => {
  if (returning === false) {
    await run(db, b.build());
    return undefined;
  }

  const cols = returning === true
    ? Object.values(table.columns)
    : returning.map(key => columnOf(table, key));

  // an empty RETURNING isn't valid SQL, but it still takes one to know how
  // many rows were affected
  if (cols.length === 0) {
    const rows = await run(db, b.push(' RETURNING 1').build());
    return rows.map(() => ({}));
  }

  b.push(' RETURNING ').join(cols, ', ', col => b.push(ref(col), ' AS ', quote(col.key)));

  const rows = await run(db, b.build());
  return rows.map(decoder(db.dialect, cols));
};

// ─── where ───────────────────────────────────────────────────────────────────

type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'not like' | 'in' | 'not in' | 'is' | 'is not';

type ValueFor<V, O extends Op> =
  O extends 'is' | 'is not' ? null
  : O extends 'in' | 'not in' ? NonNullable<V>[]
  : O extends 'like' | 'not like' ? string
  : NonNullable<V>;

type ExprNode =
  | { key: string; op: Op; value: unknown }
  | { group: 'AND' | 'OR'; exprs: ExprNode[] };

declare const COLUMNS: unique symbol;

// the columns are type-only, so `.where` can infer them back into `expr`'s
// arguments (keys, operators and values get checked and autocompleted)
type Expr<C extends Columns> = ExprNode & { readonly [COLUMNS]?: (columns: C) => C };

const expr = Object.assign(
  <C extends Columns, K extends keyof C & string, O extends Op>(key: K, op: O, value: ValueFor<C[K]['output'], O>): Expr<C> => ({ key, op, value }),
  {
    and: <C extends Columns>(exprs: Expr<C>[]): Expr<C> => ({ group: 'AND', exprs }),
    or: <C extends Columns>(exprs: Expr<C>[]): Expr<C> => ({ group: 'OR', exprs }),
  },
);

type Condition =
  | { col: Column; op: Op; value: unknown }
  | { group: 'AND' | 'OR'; conditions: Condition[] };

const toCondition = (table: Table, node: ExprNode): Condition => 'group' in node
  ? { group: node.group, conditions: node.exprs.map(expr => toCondition(table, expr)) }
  : { col: columnOf(table, node.key), op: node.op, value: node.value };

const renderCondition = (b: SqlBuilder, qualifier?: string) => (condition: Condition): SqlBuilder => {
  if ('group' in condition) {
    const { group, conditions } = condition;
    if (conditions.length === 0) return b.push(group === 'AND' ? '1 = 1' : '1 = 0');
    return b.push('(').join(conditions, ` ${group} `, renderCondition(b, qualifier)).push(')');
  }

  const { col, op, value } = condition;
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

// ─── changes ─────────────────────────────────────────────────────────────────

type Changes<C extends Columns> = {
  set?: InferForUpdate<C>;
  inc?: { [K in NumericKeys<C>]?: number };
};

type Assignment = { col: Column; op: 'set' | 'inc' | 'replace'; value?: unknown };

const parseChanges = (table: Table, { set = {}, inc = {}, replace = [] }: { set?: Row; inc?: Row; replace?: string[] }) => {
  const updatable = Object.values(table.columns).filter(col => !col.generated && !col.primaryKey);
  const numeric = updatable.filter(col => ['DECIMAL', 'FLOAT', 'INTEGER'].includes(col.type));

  const sets = std.parseOrThrow(std.strictObject(Object.fromEntries(updatable.map(col => [col.key, std.optional(col.schema)]))), set);
  const incs = std.parseOrThrow(std.strictObject(Object.fromEntries(numeric.map(col => [col.key, std.optional(std.number())]))), inc);

  const replaced = replace.map(key => {
    const col = updatable.find(col => col.key === key);
    if (!col) throw new Error(`Cannot replace "${key}": it's not an updatable field of "${table.name}"`);
    return col;
  });

  return [
    ...Object.entries(sets).filter(([, value]) => value !== undefined).map(([key, value]) => ({ col: columnOf(table, key), op: 'set', value })),
    ...Object.entries(incs).filter(([, value]) => value !== undefined).map(([key, value]) => ({ col: columnOf(table, key), op: 'inc', value })),
    ...replaced.map(col => ({ col, op: 'replace' })),
  ] as Assignment[];
};

// on conflict, `qualifier` tells the row's current value apart from EXCLUDED's
const renderAssignments = (b: SqlBuilder, assignments: Assignment[], qualifier?: string) => b
  .join(assignments, ', ', ({ col, op, value }) => {
    if (op === 'replace') return b.push(ref(col), ' = EXCLUDED.', quote(col.name));
    if (op === 'inc') return b.push(ref(col), ' = ', ref(col, qualifier), ' + ').param(value);
    return b.push(ref(col), ' = ').param(encode(b.dialect, col, value));
  });

// ─── insert ──────────────────────────────────────────────────────────────────

// `throw` is the same as no conflict handling at all, and `replace` sets
// fields to the values that were about to be inserted
type Conflict<C extends Columns> = {
  on: (keyof C & string)[];
  do: 'nothing' | 'throw' | Changes<C> & { replace?: (keyof InferForUpdate<C> & string)[] };
};

type InsertOptions<C extends Columns> = { conflict?: Conflict<C> };

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

  insert(db: IDatabase, options?: InsertOptions<T['columns']> & { returning?: true }): Promise<Infer<T['columns']>[]>;
  insert(db: IDatabase, options: InsertOptions<T['columns']> & { returning: false }): Promise<undefined>;
  insert<K extends keyof T['columns'] & string>(db: IDatabase, options: InsertOptions<T['columns']> & { returning: K[] }): Promise<Expand<Pick<Infer<T['columns']>, K>>[]>;
  async insert(db: IDatabase, { returning = true, conflict }: { returning?: Returning, conflict?: { on: string[], do: 'nothing' | 'throw' | Row } } = {}) {
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

    if (conflict) this.renderConflict(b, conflict);

    return await runReturning(db, b, this.table, returning);
  }

  private renderConflict(b: SqlBuilder, conflict: { on: string[], do: 'nothing' | 'throw' | Row }) {
    if (conflict.do === 'throw') return b;

    b.push(' ON CONFLICT');
    if (conflict.on.length > 0) b.push(' (', conflict.on.map(key => quote(columnOf(this.table, key).name)).join(', '), ')');
    if (conflict.do === 'nothing') return b.push(' DO NOTHING');

    const assignments = parseChanges(this.table, conflict.do);
    if (assignments.length === 0) throw new Error('Nothing to update on conflict: `set`, `inc` and `replace` are empty');

    return renderAssignments(b.push(' DO UPDATE SET '), assignments, this.table.name);
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

class QueryBuilder<T extends Table> {
  constructor(private readonly query: Query<T>) { }

  where<K extends keyof T['columns'] & string, O extends Op>(key: K, op: O, value: ValueFor<T['columns'][K]['output'], O>): QueryBuilder<T>;
  where(expr: Expr<T['columns']>): QueryBuilder<T>;
  where(...args: [string, Op, unknown] | [ExprNode]) {
    const node = args.length === 1 ? args[0] : { key: args[0], op: args[1], value: args[2] };
    return new QueryBuilder({ ...this.query, where: [...this.query.where, toCondition(this.query.table, node)] });
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
    const { table } = this.query;
    const cols = keys
      ? keys.map(key => columnOf(table, key))
      : Object.values(table.columns);

    const rows = await run(db, this.renderSelect(new SqlBuilder(db.dialect), cols).build());
    return rows.map(decoder(db.dialect, cols)) as Expand<Pick<Infer<T['columns']>, K>>[];
  }

  async exists(db: IDatabase) {
    // keeps a `limit(0)`, which can never match
    const rows = await this.limit(Math.min(this.query.limit ?? 1, 1)).select(db, []);
    return rows.length > 0;
  }

  // counts the rows `select` would return: as a subquery, limit and offset
  // still apply, and postgres doesn't take ORDER BY next to a bare COUNT(*)
  async count(db: IDatabase) {
    const b = new SqlBuilder(db.dialect).push('SELECT COUNT(*) AS "count" FROM (');
    const [row] = await run(db, this.renderSelect(b, []).push(') AS "q"').build());
    // postgres returns COUNT(*) as a bigint
    return Number(row!['count']);
  }

  update(db: IDatabase, changes: Changes<T['columns']> & { returning: false }): Promise<undefined>;
  update<K extends keyof T['columns'] & string>(db: IDatabase, changes: Changes<T['columns']> & { returning: K[] }): Promise<Expand<Pick<Infer<T['columns']>, K>>[]>;
  update(db: IDatabase, changes: Changes<T['columns']> & { returning?: true }): Promise<Infer<T['columns']>[]>;
  async update(db: IDatabase, { returning = true, ...changes }: Changes<T['columns']> & { returning?: Returning }) {
    this.assertUnbounded('update');

    const { table, where } = this.query;
    const assignments = parseChanges(table, changes);
    if (assignments.length === 0) throw new Error('Nothing to update: both `set` and `inc` are empty');

    const b = new SqlBuilder(db.dialect).push('UPDATE ', quote(table.name), ' SET ');

    renderAssignments(b, assignments);
    renderWhere(b, where);

    return await runReturning(db, b, table, returning);
  }

  delete(db: IDatabase, options: { returning: true }): Promise<Infer<T['columns']>[]>;
  delete<K extends keyof T['columns'] & string>(db: IDatabase, options: { returning: K[] }): Promise<Expand<Pick<Infer<T['columns']>, K>>[]>;
  delete(db: IDatabase, options?: { returning?: false }): Promise<undefined>;
  async delete(db: IDatabase, { returning = false }: { returning?: Returning } = {}) {
    this.assertUnbounded('delete');

    const { table, where } = this.query;
    const b = new SqlBuilder(db.dialect).push('DELETE FROM ', quote(table.name));

    renderWhere(b, where);

    return await runReturning(db, b, table, returning);
  }

  private renderSelect(b: SqlBuilder, cols: Column[]) {
    const { table, where, orderBy, limit, offset } = this.query;

    b.push('SELECT ');

    // an empty select list isn't valid SQL, but each matching row still needs
    // an (empty) object
    if (cols.length === 0) b.push('1');
    else b.join(cols, ', ', col => b.push(ref(col, table.alias), ' AS ', quote(col.key)));

    b.push(' FROM ', quote(table.name), ' AS ', quote(table.alias));

    renderWhere(b, where, table.alias);
    if (orderBy.length > 0) b.push(' ORDER BY ').join(orderBy, ', ', ([col, dir]) => b.push(ref(col, table.alias), ' ', dir));
    // sqlite requires LIMIT whenever there's an OFFSET, and there's no "no
    // limit" value both sqlite and postgres accept other than a huge number
    if (limit !== undefined || offset !== undefined) b.push(' LIMIT ').param(limit ?? Number.MAX_SAFE_INTEGER);
    if (offset !== undefined) b.push(' OFFSET ').param(offset);

    return b;
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

type IndexOptions = { ifNotExists?: boolean, name?: string };

const createIndex = <T extends Table>(table: T, keys: (keyof T['columns'] & string)[], {
  ifNotExists = false,
  name,
  unique = false,
}: IndexOptions & { unique?: boolean } = {}) => ({
  onto: async (db: IDatabase) => {
    const cols = keys.map(key => columnOf(table, key).name);
    const index = name ?? `${table.name}_${cols.join('_')}_index`;
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(index)} ON ${quote(table.name)} (${cols.map(quote).join(', ')})`;
    await run(db, { sql, params: [] });
  },
});

const create = {
  table: (table: Table, { ifNotExists = false }: { ifNotExists?: boolean } = {}) => ({
    onto: async (db: IDatabase) => {
      const cols = Object.values(table.columns).map(col => renderColumnDefinition(db.dialect, col));
      const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(table.name)} (${cols.join(', ')})`;
      await run(db, { sql, params: [] });
    },
  }),
  index: createIndex,
  uniqueIndex: <T extends Table>(table: T, keys: (keyof T['columns'] & string)[], options: IndexOptions = {}) =>
    createIndex(table, keys, { ...options, unique: true }),
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
  type Expr,
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
  exec,
  expr,
  from,
  into,
  types as t,
};
