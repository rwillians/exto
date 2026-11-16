import * as std from './standard-schema';
import { ValidationError } from './standard-schema';
import { type Expand, raise, snakeCase } from './utils';

// ─── columns ─────────────────────────────────────────────────────────────────

type Primitive =
  'BIGINT'
  | 'BINARY'
  | 'BOOLEAN'
  | 'CITEXT'
  | 'DATE'
  | 'DECIMAL'
  | 'FLOAT'
  | 'INTEGER'
  | 'JSON'
  | 'SEQUENCE'
  | 'STRING'
  | 'TEXT'
  | 'TIMESTAMP'
  | 'UUID';

const NUMERIC: readonly Primitive[] = ['BIGINT', 'DECIMAL', 'FLOAT', 'INTEGER', 'SEQUENCE'];
type NumericType = 'BIGINT' | 'DECIMAL' | 'FLOAT' | 'INTEGER' | 'SEQUENCE';

type ColumnProps<S extends std.Schema = std.Schema> = {
  type: Primitive;
  schema: S;
  default?: unknown;
  generated?: true;
  length?: number;
  precision?: number;
  scale?: number;
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
    if (this.props.type !== 'UUID') throw new Error('Only UUID columns can be generated, use t.sequence() for integers');
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
  bigint: () => column({ type: 'BIGINT', schema: std.bigint() }),
  binary: () => column({ type: 'BINARY', schema: std.instanceOf(Uint8Array) }),
  boolean: () => column({ type: 'BOOLEAN', schema: std.boolean() }),
  // case-insensitive text; postgres needs `CREATE EXTENSION citext` for it
  citext: () => column({ type: 'CITEXT', schema: std.string() }),
  // a calendar date, as a `YYYY-MM-DD` string
  date: () => column({ type: 'DATE', schema: std.isoDate() }),
  // `precision` and `scale` only shape postgres' NUMERIC; values are still
  // numbers, so they're as exact as a double
  decimal: (options?: { precision: number, scale: number }) => column({ type: 'DECIMAL', schema: std.number(), ...options }),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => column({
    type: 'STRING',
    schema: std.enumOf(values),
    length: Math.max(...values.map(value => value.length)),
  }),
  float: () => column({ type: 'FLOAT', schema: std.number() }),
  integer: () => column({ type: 'INTEGER', schema: std.integer() }),
  // any JSON document, validated by the given standard schema
  json: <S extends std.Schema>(schema: S) => column({ type: 'JSON', schema }),
  record: () => column({ type: 'JSON', schema: std.record() }),
  // an integer the database generates, counting up
  sequence: () => column({ type: 'SEQUENCE', schema: std.integer(), generated: true }),
  string: ({ size = 255 }: { size?: number } = {}) => column({ type: 'STRING', schema: std.string({ max: size }), length: size }),
  text: () => column({ type: 'TEXT', schema: std.string() }),
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
declare const FRAGMENT: unique symbol;

type Op =
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'IS' | 'IS NOT'
  | 'IS DISTINCT FROM' | 'IS NOT DISTINCT FROM'
  | 'LIKE' | 'NOT LIKE'
  | 'ILIKE' | 'NOT ILIKE'
  | 'IN' | 'NOT IN'
  | 'BETWEEN' | 'NOT BETWEEN';

type Fn = 'COUNT' | 'SUM' | 'MIN' | 'MAX';

// a plain value, encoded the way the node it goes with stores its values
type Value = { kind: 'value'; value: unknown };

// what an operand renders to: a column (or a field nested in one), a fragment
// of raw SQL, or an expression built from other nodes
type Node =
  | { kind: 'ref'; alias: string; col: Column; path: Column[] }
  | { kind: 'fragment'; strings: readonly string[]; values: unknown[] }
  | { kind: 'typed'; node: Node; col: Column }
  | { kind: 'call'; fn: Fn; arg: Node; distinct?: true }
  | { kind: 'coalesce'; nodes: [Node, ...(Node | Value)[]] }
  | { kind: 'compare'; lhs: Node; op: Op; rhs: Node | Value }
  | { kind: 'match'; lhs: Node; regex: RegExp }
  | { kind: 'group'; op: 'AND' | 'OR'; nodes: Node[] }
  | { kind: 'not'; node: Node }
  | { kind: 'collect'; fields: Field[]; filter?: Node };

// anything that renders to SQL. Type only: `aliases` are the tables it reads
// from, `value` is what it evaluates to, and `nulls` are the aliases whose
// missing rows, all of them, turn it into null (in an outer join)
type Operand<A extends string = string, V = unknown, N extends string = string> = {
  readonly [NODE]: Node;
  readonly [OPERAND]: { aliases: A; value: V; nulls: N };
};

type ColumnRef<A extends string = string, K extends string = string, V = unknown> = Operand<A, V, A> & {
  readonly [KEY]: K; // type only
};

type NullOf<C extends Column> = C extends { nullable: true } ? null : never;

// the fields of `embedded.one()` columns are referenced as properties of
// the column's reference, e.g. `tasks.payload.kind`. `Null` is null when
// any column they're nested in is optional, since they read null then too
type FieldRefs<A extends string, C extends Column, Null = NullOf<C>> = C extends { fields: infer F extends Columns }
  ? C extends { many: true } ? {} : { readonly [K in keyof F & string]: Operand<A, F[K]['output'] | Null, A> & FieldRefs<A, F[K], Null | NullOf<F[K]>> }
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
  [K in keyof C]: C[K] extends OmitOnUpdate ? never : C[K]['type'] extends NumericType ? K : never;
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
type DialectName = 'postgres' | 'sqlite' | (string & {});

/**
 * Everything that differs between database engines. SQL generation, param
 * collection, validation and encoding/decoding all live in the core.
 *
 * `generated` returns the DDL that makes the database generate the column's
 * value, or `undefined` when the database can't natively, in which case the
 * value is generated client-side on insert.
 *
 * `operators` overrides how an operator is written, when the database
 * doesn't take its standard spelling.
 *
 * `json` extracts a field nested in a JSON column, as an SQL value of the
 * field's type: a JSON document itself when the field is a JSON one (a
 * record, or embedded fields).
 *
 * `jsonOf` renders a column's value the way it reads inside a JSON document
 * (see `fromJson`), and `collect` a JSON array with an object per row:
 * `entries` are its keys and their JSON values, and `filter` leaves out the
 * rows it's false for. Parameters are positional, so their SQL has to appear
 * in the given order, `filter` last.
 *
 * `match` tests text against a regular expression, given as the `pattern`
 * parameter's SQL plus the regular expression itself for its flags. It
 * throws for flags the database has no equivalent for, rather than dropping
 * them. The text's SQL comes first, to keep parameters in order.
 */
interface Dialect {
  name: DialectName;
  placeholder(index: number): string;
  type(column: Column): string;
  generated(column: Column): string | undefined;
  json(sql: string, path: string[], type: Primitive): string;
  jsonOf(sql: string, type: Primitive): string;
  collect(entries: [key: string, sql: string][], filter: string | undefined): string;
  match(sql: string, pattern: string, regex: RegExp): string;
  // operators the database spells differently, e.g. ILIKE
  operators: Partial<Record<Op, string>>;
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

// inside JSON documents, timestamps are ISO 8601 strings, bigints are
// strings of digits and binaries are hex strings
const toJson = (col: Column, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (col.fields && col.many) return (value as Row[]).map(item => toJson({ ...col, many: undefined }, item));
  if (col.fields) return Object.fromEntries(Object.values(col.fields).map(field => [field.key, toJson(field, (value as Row)[field.key])]));
  if (col.type === 'TIMESTAMP') return (value as Date).toISOString();
  if (col.type === 'BIGINT') return String(value);
  if (col.type === 'BINARY') return Buffer.from(value as Uint8Array).toString('hex');

  return value;
};

// databases may read JSON numbers as bigints, booleans as numbers and
// timestamps as epoch milliseconds
const fromJson = (col: Column, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (col.fields && col.many) return (value as Row[]).map(item => fromJson({ ...col, many: undefined }, item));
  if (col.fields) return Object.fromEntries(Object.values(col.fields).map(field => [field.key, fromJson(field, (value as Row)[field.key])]));
  if (col.type === 'TIMESTAMP') return new Date(typeof value === 'bigint' ? Number(value) : value as string | number);
  if (col.type === 'BIGINT') return BigInt(value as string);
  if (col.type === 'BINARY') return new Uint8Array(Buffer.from(value as string, 'hex'));
  if (NUMERIC.includes(col.type)) return Number(value);
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

  // the SQL `fn` pushes, rather than pushed; its parameters are kept
  capture(fn: () => unknown) {
    const start = this.frags.length;
    fn();
    return this.frags.splice(start).join('');
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

const renderTable = (b: SqlBuilder, table: Table) => table[ALIAS] === table[NAME]
  ? b.push(quote(table[NAME]))
  : b.push(quote(table[NAME]), ' AS ', quote(table[ALIAS]));

const renderNode = (b: SqlBuilder, node: Node): SqlBuilder => {
  switch (node.kind) {
    case 'ref': {
      const sql = refSql(node);
      if (node.path.length === 0) return b.push(sql);
      return b.push(b.dialect.json(sql, node.path.map(field => field.name), node.path.at(-1)!.type));
    }

    case 'collect': {
      const entries = node.fields.map(([key, field]): [string, string] => [key, b.capture(() => renderJson(b, field))]);
      const filter = node.filter && b.capture(() => renderNode(b, node.filter!));
      return b.push(b.dialect.collect(entries, filter));
    }

    case 'coalesce': {
      const [first] = node.nodes;
      return b.push('COALESCE(').join(node.nodes, ', ', item => item.kind === 'value'
        ? b.param(encodeFor(b.dialect, first, item.value))
        : renderNode(b, item)).push(')');
    }

    case 'compare': {
      const { lhs, op, rhs } = node;
      const operator = b.dialect.operators[op] ?? op;
      if (rhs.kind !== 'value') return renderNode(renderNode(b, lhs).push(' ', operator, ' '), rhs);

      const param = (value: unknown) => b.param(encodeFor(b.dialect, lhs, value));
      const values = rhs.value as unknown[];

      switch (op) {
        case 'IS':
        case 'IS NOT':
          return renderNode(b, lhs).push(' ', operator, ' ', String(rhs.value).toUpperCase());
        // `IN ()` isn't valid SQL, but an empty list still has an answer
        case 'IN':
        case 'NOT IN':
          if (values.length === 0) return b.push(op === 'IN' ? '1 = 0' : '1 = 1');
          return renderNode(b, lhs).push(' ', operator, ' (').join(values, ', ', param).push(')');
        case 'BETWEEN':
        case 'NOT BETWEEN':
          renderNode(b, lhs).push(' ', operator, ' ');
          param(values[0]).push(' AND ');
          return param(values[1]);
        default:
          renderNode(b, lhs).push(' ', operator, ' ');
          return param(rhs.value);
      }
    }

    case 'match': {
      const sql = b.capture(() => renderNode(b, node.lhs));
      const pattern = b.capture(() => b.param(node.regex.source));
      return b.push(b.dialect.match(sql, pattern, node.regex));
    }

    case 'not':
      return renderNode(b.push('NOT ('), node.node).push(')');

    case 'typed':
      return renderNode(b, node.node);

    case 'group': {
      const { op, nodes } = node;
      if (nodes.length === 0) return b.push(op === 'AND' ? '1 = 1' : '1 = 0');
      return b.push('(').join(nodes, ` ${op} `, node => renderNode(b, node)).push(')');
    }

    case 'fragment':
      node.strings.forEach((str, i) => {
        b.push(str);
        if (i >= node.values.length) return;
        const value = node.values[i];
        if (isOperand(value)) renderNode(b, value[NODE]);
        else b.param(value);
      });
      return b;

    case 'call': {
      const distinct = node.distinct ? 'DISTINCT ' : '';
      return node.fn === 'SUM'
        ? renderNode(b.push('COALESCE(SUM(', distinct), node.arg).push('), 0)')
        : renderNode(b.push(node.fn, '(', distinct), node.arg).push(')');
    }
  }
};

const refSql = (node: Node & { kind: 'ref' }) => `${quote(node.alias)}.${quote(node.col.name)}`;

// an operand as a value inside a JSON document: columns as `fromJson` reads
// them, anything else as it is
const renderJson = (b: SqlBuilder, node: Node) => {
  if (node.kind === 'typed') return b.push(b.dialect.jsonOf(b.capture(() => renderNode(b, node.node)), node.col.type));
  if (node.kind !== 'ref') return renderNode(b, node);
  if (node.path.length === 0) return b.push(b.dialect.jsonOf(refSql(node), node.col.type));
  return b.push(b.dialect.jsonOf(b.dialect.json(refSql(node), node.path.map(field => field.name), 'JSON'), 'JSON'));
};

const fromJsonFor = (node: Node, value: unknown) => {
  if (node.kind === 'typed') return fromJson(node.col, value);
  if (node.kind === 'ref') return fromJson(node.path.at(-1) ?? node.col, value);
  return value;
};

// the node whose values another one reads like: the lowest and highest values
// read like those they're picked from, and a coalesce like its first operand
const valuesOf = (node: Node): Node => {
  if (node.kind === 'call' && (node.fn === 'MIN' || node.fn === 'MAX')) return valuesOf(node.arg);
  if (node.kind === 'coalesce') return valuesOf(node.nodes[0]);
  return node;
};

// values compared with a column are encoded the way the column stores them
const encodeFor = (dialect: Dialect, operand: Node, value: unknown) => {
  const node = valuesOf(operand);
  if (node.kind === 'typed') return encode(dialect, node.col, value);
  if (node.kind !== 'ref') return value;
  if (node.path.length === 0) return encode(dialect, node.col, value);

  const leaf = node.path.at(-1)!;
  return leaf.type === 'JSON' ? dialect.codecs.JSON.encode(toJson(leaf, value)) : toJson(leaf, value);
};

const decodeFor = (dialect: Dialect, operand: Node) => (value: unknown) => {
  const node = valuesOf(operand);
  if (node.kind === 'typed') return decode(dialect, node.col, value);
  if (node.kind === 'call') return Number(value ?? 0);
  if (node.kind === 'collect') return (dialect.codecs.JSON.decode(value) as Row[])
    .map(row => Object.fromEntries(node.fields.map(([key, field]) => [key, fromJsonFor(field, row[key])])));
  if (node.kind !== 'ref') return typeof value === 'bigint' ? Number(value) : value;
  if (node.path.length === 0) return decode(dialect, node.col, value);

  const leaf = node.path.at(-1)!;
  if (value === null || value === undefined) return null;
  return fromJson(leaf, leaf.type === 'JSON' ? dialect.codecs.JSON.decode(value) : value);
};

// ─── expressions ─────────────────────────────────────────────────────────────

type ValueOf<O> = O extends { readonly [OPERAND]: { value: infer V } } ? V : never;
type AliasesOf<O> = O extends { readonly [OPERAND]: { aliases: infer A extends string } } ? A : never;
type NullsOf<O> = O extends { readonly [OPERAND]: { nulls: infer N extends string } } ? N : never;

// the value an operand reads in a query where the `N` aliases may be missing
type ValueIn<O, N extends string> = [NullsOf<O>] extends [never]
  ? ValueOf<O>
  : [Exclude<NullsOf<O>, N>] extends [never] ? ValueOf<O> | null : ValueOf<O>;

// operators that also take another operand
type ColumnOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'IS DISTINCT FROM' | 'IS NOT DISTINCT FROM';
type MatchOp = 'LIKE' | 'NOT LIKE' | 'ILIKE' | 'NOT ILIKE';

// `IS` and `IS NOT` take null (when the value can be null) and booleans
// (when it's a boolean)
type ValueFor<V, O extends Op> = O extends 'IS' | 'IS NOT'
  ? (null extends V ? null : never) | (boolean extends NonNullable<V> ? boolean : never)
  : O extends MatchOp
  ? [NonNullable<V>] extends [string] ? string : unknown extends V ? string : never
  : O extends 'IN' | 'NOT IN'
  ? readonly NonNullable<V>[]
  : O extends 'BETWEEN' | 'NOT BETWEEN'
  ? readonly [low: NonNullable<V>, high: NonNullable<V>]
  : O extends 'IS DISTINCT FROM' | 'IS NOT DISTINCT FROM'
  ? NonNullable<V> | null
  : NonNullable<V>;

// comparisons also take another operand, as long as its values are compatible
type RhsFor<V, O extends Op, A extends string = string> =
  | ValueFor<V, O>
  | (O extends ColumnOp ? Operand<A, NonNullable<V> | null> : never);

type Condition<A extends string = string> = Operand<A, boolean, never>;

// type only: a fragment's SQL could be anything, so it goes wherever a
// value or a condition does
type Fragment<A extends string = string> = Operand<A, unknown, never> & {
  readonly [FRAGMENT]: true;
  as<P extends ColumnProps>(type: ColumnBuilder<P>): Operand<A, std.output<P['schema']>, never>;
};

type Predicate<A extends string = string> = Condition<A> | Fragment<A>;

// LIKE only matches text the same way across databases
const TEXTUAL: readonly Primitive[] = ['CITEXT', 'STRING', 'TEXT'];
const COLUMN_OPS: readonly Op[] = ['=', '!=', '<', '<=', '>', '>=', 'IS DISTINCT FROM', 'IS NOT DISTINCT FROM'];

const assertTextual = (what: string, node: Node) => {
  if (node.kind === 'ref' && !TEXTUAL.includes((node.path.at(-1) ?? node.col).type)) {
    raise(`${what} only takes text columns, "${[node.alias, node.col.key, ...node.path.map(field => field.key)].join('.')}" isn't one`);
  }
};

const compare = (lhs: Operand, op: Op, rhs: unknown): Node => {
  const node = lhs[NODE];
  const fail = (message: string) => raise(`"${op}" ${message}, got ${Array.isArray(rhs) ? `[${rhs.join(', ')}]` : String(rhs)}`);

  if (isOperand(rhs) && !COLUMN_OPS.includes(op)) fail('takes a value, not another operand');

  switch (op) {
    case 'IS':
    case 'IS NOT':
      if (rhs !== null && rhs !== true && rhs !== false) fail('takes null, true or false');
      break;
    case 'IN':
    case 'NOT IN':
      if (!Array.isArray(rhs)) fail('takes a list of values');
      break;
    case 'BETWEEN':
    case 'NOT BETWEEN':
      if (!Array.isArray(rhs) || rhs.length !== 2) fail('takes a [low, high] pair');
      break;
    case 'LIKE':
    case 'NOT LIKE':
    case 'ILIKE':
    case 'NOT ILIKE':
      if (typeof rhs !== 'string') fail('takes a string pattern');
      assertTextual(`"${op}"`, node);
      break;
  }

  return {
    kind: 'compare',
    lhs: node,
    op,
    rhs: isOperand(rhs) ? rhs[NODE] : { kind: 'value', value: rhs },
  };
};

// a value, or another operand: one generic for both would infer it as its
// constraint, losing the operand's aliases
type ExprOf = {
  <L extends Operand, O extends Op>(lhs: L, op: O, rhs: ValueFor<ValueOf<L>, O>): Condition<AliasesOf<L>>;
  <L extends Operand, O extends ColumnOp, R extends Operand<string, NonNullable<ValueOf<L>> | null>>(lhs: L, op: O, rhs: R): Condition<AliasesOf<L> | AliasesOf<R>>;
};

const exprOf: ExprOf = (lhs: Operand, op: Op, rhs: unknown) => operand(compare(lhs, op, rhs)) as never;

const group = (op: 'AND' | 'OR') => <E extends Predicate>(exprs: E[]) =>
  operand({ kind: 'group', op, nodes: exprs.map(expr => expr[NODE]) }) as unknown as Condition<AliasesOf<E>>;

// true where the condition is false. Like SQL, it's still null where the
// condition is null
const not = <E extends Predicate>(expr: E) =>
  operand({ kind: 'not', node: expr[NODE] }) as unknown as Condition<AliasesOf<E>>;

const call = (fn: Fn, distinct?: true) => (arg: Operand) => operand({ kind: 'call', fn, arg: arg[NODE], ...(distinct && { distinct }) });

type Counted = <O extends Operand>(arg: O) => Operand<AliasesOf<O>, number, never>;
type Summed = <O extends Operand<string, number | null>>(arg: O) => Operand<AliasesOf<O>, number, never>;

// values with an order to them (booleans have none on postgres)
type Orderable = number | bigint | string | Date;

// a group of no rows has neither a lowest nor a highest value
type Picked = <O extends Operand<string, Orderable | null>>(arg: O) => Operand<AliasesOf<O>, NonNullable<ValueOf<O>> | null, never>;

// the operands (and plain values) of a coalesce that never read null, and
// those that read null only when a join leaves their table's row missing
type Sure<U> = U extends Operand ? null extends ValueOf<U> ? never : [NullsOf<U>] extends [never] ? U : never : U;
type Joined<U> = U extends Operand ? null extends ValueOf<U> ? never : U : never;

// coalesce reads null only when all of its operands may: never once any of
// them is sure to read a value, otherwise when the rows of every table its
// other operands read from are missing
type Coalesce = <L extends Operand, const R extends readonly (Operand<string, NonNullable<ValueOf<L>> | null> | NonNullable<ValueOf<L>>)[]>(lhs: L, ...rest: R) => Operand<
  AliasesOf<L | R[number]>,
  NonNullable<ValueOf<L>> | ([Joined<L | R[number]> | Sure<L | R[number]>] extends [never] ? null : never),
  [Sure<L | R[number]>] extends [never] ? NullsOf<Joined<L | R[number]>> : never
>;

// plain values are encoded the way the first operand stores its values
const coalesce: Coalesce = (lhs: Operand, ...rest: readonly unknown[]) => operand({
  kind: 'coalesce',
  nodes: [lhs[NODE], ...rest.map(item => isOperand(item) ? item[NODE] : { kind: 'value' as const, value: item })],
}) as never;

// whether text matches a regular expression. Each database has its own flavor
// of them, and its own say on which flags it takes
type Match = <L extends Operand<string, string | null> | Fragment>(lhs: L, regex: RegExp) => Condition<AliasesOf<L>>;

const match: Match = (lhs: Operand, regex: RegExp) => {
  if (!(regex instanceof RegExp)) raise(`"expr.match" takes a regular expression, got ${String(regex)}`);
  assertTextual('"expr.match"', lhs[NODE]);
  return operand({ kind: 'match', lhs: lhs[NODE], regex }) as never;
};

const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && NAME in value;

// the rows of a table (or of a projection) in a group, as a list. Rows a
// left join found no match for are left out, telling them apart by a
// column that's never null: the table's primary key, or any required one
type Collect = {
  <T extends Table>(table: T): Operand<AliasOf<T>, InferForSelect<ColumnsOf<T>>[], never>;
  <P extends Record<string, Operand>>(projection: P): Operand<AliasesOf<P[keyof P]>, Projected<P, never>[], never>;
};

const collect: Collect = (source: Table | Record<string, Operand>) => {
  const fields = Object.entries(source).map(([key, value]): Field => isOperand(value)
    ? [key, value[NODE]]
    : raise(`"${key}" must be a column reference or an expression`));

  const refs = isTable(source)
    ? columnsOf(source).map((col): Node => ({ kind: 'ref', alias: source[ALIAS], col, path: [] }))
    : fields.map(([, node]) => node);

  const required = refs
    .filter((node): node is Node & { kind: 'ref' } => node.kind === 'ref' && node.path.length === 0 && !node.col.nullable)
    .sort((a, b) => Number(b.col.primaryKey ?? false) - Number(a.col.primaryKey ?? false))[0];

  const filter = required && compare(operand(required), 'IS NOT', null);
  return operand({ kind: 'collect', fields, filter }) as never;
};

// aggregates: a sum of no rows is 0, rather than SQL's null, and so is a
// count; a collect of no rows is an empty list. `distinct` counts (or sums)
// each value once
const expr = Object.assign(exprOf, {
  and: group('AND'),
  or: group('OR'),
  not,
  coalesce,
  match,
  count: Object.assign(call('COUNT') as Counted, { distinct: call('COUNT', true) as Counted }),
  sum: Object.assign(call('SUM') as Summed, { distinct: call('SUM', true) as Summed }),
  min: call('MIN') as Picked,
  max: call('MAX') as Picked,
  collect,
});

// a fragment of raw SQL: interpolated operands are rendered in place, and
// any other value is passed as a parameter. It reads as a value, or as a
// condition of its own. `as` reads it as a column type's values, e.g.
// `t.integer()`: typed, decoded and compared like that column's, while its
// SQL stays as written
const f = <V extends unknown[]>(strings: TemplateStringsArray, ...values: V) => {
  const node: Node = { kind: 'fragment', strings: [...strings], values };

  return Object.defineProperty(operand(node), 'as', {
    value: (type: unknown) => type instanceof ColumnBuilder
      ? operand({ kind: 'typed', node, col: type.props as Column })
      : raise(`A fragment is read as a column type, e.g. t.integer(), got ${String(type)}`),
  }) as unknown as Fragment<AliasesOf<V[number]>>;
};

// every table an operand reads from must be part of the query, under the
// alias it's referenced by
type Scope = Map<string, Table>;

const assertInScope = (scope: Scope, node: Node): Node => {
  switch (node.kind) {
    case 'ref': {
      const table = scope.get(node.alias);
      if (!table || !columnsOf(table).includes(node.col)) throw new Error(`"${node.alias}.${node.col.key}" isn't part of the query`);
      break;
    }
    case 'compare':
      assertInScope(scope, node.lhs);
      if (node.rhs.kind !== 'value') assertInScope(scope, node.rhs);
      break;
    case 'match':
      assertInScope(scope, node.lhs);
      break;
    case 'not':
      assertInScope(scope, node.node);
      break;
    case 'typed':
      assertInScope(scope, node.node);
      break;
    case 'group':
      node.nodes.forEach(node => assertInScope(scope, node));
      break;
    case 'fragment':
      node.values.filter(isOperand).forEach(value => assertInScope(scope, value[NODE]));
      break;
    case 'call':
      assertInScope(scope, node.arg);
      break;
    case 'coalesce':
      node.nodes.forEach(item => item.kind !== 'value' && assertInScope(scope, item));
      break;
    case 'collect':
      node.fields.forEach(([, field]) => assertInScope(scope, field));
      if (node.filter) assertInScope(scope, node.filter);
      break;
  }

  return node;
};

const renderWhere = (b: SqlBuilder, where: Node[]) => where.length === 0
  ? b
  : b.push(' WHERE ').join(where, ' AND ', node => renderNode(b, node));

// ─── returning ───────────────────────────────────────────────────────────────

// `true` returns every column, a list returns those columns (by key or by
// reference), `false` returns nothing at all
type Returning = boolean | (string | Operand)[];

type Returnable<T extends Table> = Keys<T> | ColumnRef<AliasOf<T>, Keys<T>>;
type ReturnedKey<R> = R extends string ? R : R extends { readonly [KEY]: infer K extends string } ? K : never;
type Returned<T extends Table, R> = Pick<InferForSelect<ColumnsOf<T>>, ReturnedKey<R> & Keys<T>>;

const returnedColumn = (table: Table, item: string | Operand) => {
  if (typeof item === 'string') return columnOf(table, item);

  const node = item[NODE];
  const owned = node.kind === 'ref' && node.path.length === 0 && node.alias === table[ALIAS] && columnsOf(table).includes(node.col);
  if (!owned) throw new Error(`Only columns of "${table[ALIAS]}" can be returned`);

  return node.col;
};

const runReturning = async (db: IDatabase, b: SqlBuilder, table: Table, returning: Returning) => {
  if (returning === false) {
    await run(db, b.build());
    return undefined;
  }

  const cols = returning === true
    ? columnsOf(table)
    : returning.map(item => returnedColumn(table, item));

  // an empty RETURNING isn't valid SQL, but it still takes one to know how
  // many rows were affected
  if (cols.length === 0) {
    const rows = await run(db, b.push(' RETURNING 1').build());
    return rows.map(() => ({}));
  }

  b.push(' RETURNING ').join(cols, ', ', col => b.push(quote(col.name), ' AS ', quote(col.key)));

  const rows = await run(db, b.build());
  return rows.map(row => Object.fromEntries(cols.map(col => [col.key, decode(db.dialect, col, row[col.key])])));
};

// ─── changes ─────────────────────────────────────────────────────────────────

type Changes<C extends Columns> = {
  set?: InferForUpdate<C>;
  inc?: { [K in NumericKeys<C>]?: number };
};

type Assignment = { col: Column; op: 'set' | 'inc' | 'replace'; value?: unknown };

const parseChanges = (table: Table, { set = {}, inc = {}, replace = [] }: { set?: Row; inc?: Row; replace?: string[] }) => {
  const updatable = Object.fromEntries(columnsOf(table).filter(col => !col.generated && !col.primaryKey).map(col => [col.key, col]));
  const updatableColumn = (key: string) => updatable[key] ?? raise(`"${key}" isn't an updatable column of "${table[NAME]}"`);

  const sets = validate(updatable, set, { partial: true });

  const incs = Object.entries(inc).filter(([, by]) => by !== undefined).map(([key, by]) => {
    const col = updatableColumn(key);
    if (!NUMERIC.includes(col.type)) throw new Error(`"${key}" isn't a numeric column of "${table[NAME]}"`);
    if (!Number.isFinite(by)) throw new ValidationError([{ path: [key], message: 'must be a finite number' }]);
    return { col, op: 'inc', value: by };
  });

  return [
    ...Object.entries(sets).map(([key, value]) => ({ col: updatableColumn(key), op: 'set', value })),
    ...incs,
    ...replace.map(key => ({ col: updatableColumn(key), op: 'replace' })),
  ] as Assignment[];
};

// `qualifier` tells the row's current value apart from EXCLUDED's, on conflict
const renderAssignments = (b: SqlBuilder, assignments: Assignment[], qualifier: string) => b
  .join(assignments, ', ', ({ col, op, value }) => {
    if (op === 'replace') return b.push(quote(col.name), ' = EXCLUDED.', quote(col.name));
    if (op === 'inc') return b.push(quote(col.name), ' = ', quote(qualifier), '.', quote(col.name), ' + ').param(value);
    return b.push(quote(col.name), ' = ').param(encode(b.dialect, col, value));
  });

// ─── insert ──────────────────────────────────────────────────────────────────

// `throw` is the same as no conflict handling at all, and `replace` sets
// columns to the values that were about to be inserted
type Conflict<C extends Columns> = {
  on: (keyof C & string)[];
  do: 'nothing' | 'throw' | Changes<C> & { replace?: (keyof InferForUpdate<C> & string)[] };
};

type InsertOptions<C extends Columns> = { conflict?: Conflict<C> };

const GENERATORS: Partial<Record<Primitive, () => unknown>> = {
  UUID: () => Bun.randomUUIDv7(),
};

const generate = (col: Column) => (GENERATORS[col.type] ?? raise(`Cannot generate a value for column "${col.name}"`))();

// columns the database generates are left out of inserts
const isGeneratedByClient = (dialect: Dialect, col: Column) => col.generated === true && dialect.generated(col) === undefined;

class InsertBuilder<T extends Table> {
  constructor(private readonly table: T,
              private readonly rows: InferForInsert<ColumnsOf<T>>[] = []) { }

  values(rows: InferForInsert<ColumnsOf<T>> | InferForInsert<ColumnsOf<T>>[]) {
    return new InsertBuilder(this.table, [...this.rows, ...(Array.isArray(rows) ? rows : [rows])]);
  }

  insert(db: IDatabase, options?: InsertOptions<ColumnsOf<T>> & { returning?: true }): Promise<InferForSelect<ColumnsOf<T>>[]>;
  insert(db: IDatabase, options: InsertOptions<ColumnsOf<T>> & { returning: false }): Promise<undefined>;
  insert<R extends Returnable<T>>(db: IDatabase, options: InsertOptions<ColumnsOf<T>> & { returning: R[] }): Promise<Returned<T, R>[]>;
  async insert(db: IDatabase, { returning = true, conflict }: { returning?: Returning, conflict?: { on: string[], do: 'nothing' | 'throw' | Row } } = {}) {
    if (this.rows.length === 0) return returning === false ? undefined : [];

    const { table } = this;
    const cols = columnsOf(table).filter(col => !col.generated || isGeneratedByClient(db.dialect, col));
    const insertable = Object.fromEntries(cols.filter(col => !col.generated).map(col => [col.key, col]));
    const rows = this.rows.map(row => validate(insertable, row));

    const b = new SqlBuilder(db.dialect)
      .push('INSERT INTO ', quote(table[NAME]), ' (', cols.map(col => quote(col.name)).join(', '), ') VALUES ');

    b.join(rows, ', ', row => b
      .push('(')
      .join(cols, ', ', col => b.param(encode(db.dialect, col, col.generated ? generate(col) : row[col.key])))
      .push(')'));

    if (conflict) this.renderConflict(b, conflict);

    return await runReturning(db, b, table, returning);
  }

  private renderConflict(b: SqlBuilder, conflict: { on: string[], do: 'nothing' | 'throw' | Row }) {
    if (conflict.do === 'throw') return b;

    b.push(' ON CONFLICT');
    if (conflict.on.length > 0) b.push(' (', conflict.on.map(key => quote(columnOf(this.table, key).name)).join(', '), ')');
    if (conflict.do === 'nothing') return b.push(' DO NOTHING');

    const assignments = parseChanges(this.table, conflict.do);
    if (assignments.length === 0) throw new Error('Nothing to update on conflict: `set`, `inc` and `replace` are empty');

    return renderAssignments(b.push(' DO UPDATE SET '), assignments, this.table[NAME]);
  }
}

const into = <T extends Table>(table: T) => new InsertBuilder(table);

// ─── query ───────────────────────────────────────────────────────────────────

type Direction = 'ASC' | 'DESC';

// a field is an operand read under a key of its own
type Field = [key: string, node: Node];

type Join = 'INNER' | 'LEFT' | 'RIGHT';

type Query = {
  table: Table;
  scope: Scope;
  joins: { kind: Join; table: Table; on: Node }[];
  select?: Field[];
  distinct?: true;
  where: Node[];
  groupBy: Node[];
  having: Node[];
  orderBy: [Node, Direction][];
  limit?: number;
  offset?: number;
};

// the row a projection reads, under the projection's own keys
type Projected<P, N extends string> = Expand<{
  [K in keyof P & string]: ValueIn<P[K], N>;
}>;

// the row a query reads: a whole row of `T` (every column null when `T`'s
// row may be missing, in a right join) unless `select` picked a projection
type RowOf<T extends Table, N extends string, S> = [S] extends [Record<string, Operand>]
  ? Projected<S, N>
  : [AliasOf<T> & N] extends [never]
  ? InferForSelect<ColumnsOf<T>>
  : Expand<{ [K in keyof ColumnsOf<T>]: ColumnsOf<T>[K]['output'] | null }>;

const conditionOf = (args: [Operand, Op, unknown] | [Operand]) => args.length === 1 ? args[0][NODE] : compare(...args);

const count = (value: number, name: string) => Number.isSafeInteger(value) && value >= 0
  ? value
  : raise(`${name} must be a non-negative integer, got ${value}`);

// `T` is the queried table, `A` the aliases in scope, `N` those of them whose
// rows may be missing (joined from the other side of an outer join), and `S`
// the projection `select` picked, if any (see `RowOf`)
class QueryBuilder<T extends Table, A extends string = AliasOf<T>, N extends string = never, S = undefined> {
  constructor(private readonly query: Query) { }

  select<P extends Record<string, Operand<A>>>(projection: P) {
    const fields = Object.entries(projection).map(([key, value]): Field => isOperand(value)
      ? [key, assertInScope(this.query.scope, value[NODE])]
      : raise(`"${key}" must be a column reference or an expression`));

    return new QueryBuilder<T, A, N, P>({ ...this.query, select: fields });
  }

  // leaves out duplicate rows
  distinct() {
    return new QueryBuilder<T, A, N, S>({ ...this.query, distinct: true });
  }

  where<L extends Operand<A>, O extends Op>(lhs: L, op: O, rhs: RhsFor<ValueIn<L, N>, O, A>): QueryBuilder<T, A, N, S>;
  where(condition: Predicate<A>): QueryBuilder<T, A, N, S>;
  where(...args: [Operand, Op, unknown] | [Operand]) {
    const node = assertInScope(this.query.scope, conditionOf(args));
    return new QueryBuilder<T, A, N, S>({ ...this.query, where: [...this.query.where, node] });
  }

  // only rows with a match in the joined table
  innerJoin<J extends Table>(table: J, on: Predicate<A | AliasOf<J>>) {
    return new QueryBuilder<T, A | AliasOf<J>, N, S>(this.join('INNER', table, on));
  }

  // the joined table's columns read as null for rows it has no match for
  leftJoin<J extends Table>(table: J, on: Predicate<A | AliasOf<J>>) {
    return new QueryBuilder<T, A | AliasOf<J>, N | AliasOf<J>, S>(this.join('LEFT', table, on));
  }

  // every row of the joined table, and the columns of the tables joined so
  // far read as null for rows they have no match for
  rightJoin<J extends Table>(table: J, on: Predicate<A | AliasOf<J>>) {
    return new QueryBuilder<T, A | AliasOf<J>, A, S>(this.join('RIGHT', table, on));
  }

  groupBy(operands: Operand<A>[]) {
    const groupBy = operands.map(item => assertInScope(this.query.scope, item[NODE]));
    return new QueryBuilder<T, A, N, S>({ ...this.query, groupBy: [...this.query.groupBy, ...groupBy] });
  }

  // filters the groups, the way `where` filters rows
  having<L extends Operand<A>, O extends Op>(lhs: L, op: O, rhs: RhsFor<ValueIn<L, N>, O, A>): QueryBuilder<T, A, N, S>;
  having(condition: Predicate<A>): QueryBuilder<T, A, N, S>;
  having(...args: [Operand, Op, unknown] | [Operand]) {
    const node = assertInScope(this.query.scope, conditionOf(args));
    return new QueryBuilder<T, A, N, S>({ ...this.query, having: [...this.query.having, node] });
  }

  orderBy(operands: (Operand<A> | [Operand<A>, Direction])[]) {
    const orderBy = operands.map(item => Array.isArray(item)
      ? [assertInScope(this.query.scope, item[0][NODE]), item[1]] as [Node, Direction]
      : [assertInScope(this.query.scope, item[NODE]), 'ASC'] as [Node, Direction]);

    return new QueryBuilder<T, A, N, S>({ ...this.query, orderBy: [...this.query.orderBy, ...orderBy] });
  }

  limit(n: number) {
    return new QueryBuilder<T, A, N, S>({ ...this.query, limit: count(n, 'limit') });
  }

  offset(n: number) {
    return new QueryBuilder<T, A, N, S>({ ...this.query, offset: count(n, 'offset') });
  }

  async all(db: IDatabase) {
    const fields = this.fields();
    const rows = await run(db, this.renderSelect(new SqlBuilder(db.dialect), fields).build());
    const decoders = fields.map(([key, node]) => [key, decodeFor(db.dialect, node)] as const);

    return rows.map(row => Object.fromEntries(decoders.map(([key, decode]) => [key, decode(row[key])]))) as RowOf<T, N, S>[];
  }

  async one(db: IDatabase) {
    const [row] = await this.top().all(db);
    return row ?? null;
  }

  async exists(db: IDatabase) {
    const rows = await this.top().select({}).all(db);
    return rows.length > 0;
  }

  // counts the rows `all` would return: as a subquery, limit and offset still
  // apply, and postgres doesn't take ORDER BY next to a bare COUNT(*). Only
  // distinct rows need their columns, to tell them apart
  async count(db: IDatabase) {
    const b = new SqlBuilder(db.dialect).push('SELECT COUNT(*) AS "count" FROM (');
    const [row] = await run(db, this.renderSelect(b, this.query.distinct ? this.fields() : []).push(') AS "q"').build());
    return Number(row!['count']);
  }

  update(db: IDatabase, changes: Changes<ColumnsOf<T>> & { returning: false }): Promise<undefined>;
  update<K extends Returnable<T>>(db: IDatabase, changes: Changes<ColumnsOf<T>> & { returning: K[] }): Promise<Returned<T, K>[]>;
  update(db: IDatabase, changes: Changes<ColumnsOf<T>> & { returning?: true }): Promise<InferForSelect<ColumnsOf<T>>[]>;
  async update(db: IDatabase, { returning = true, ...changes }: Changes<ColumnsOf<T>> & { returning?: Returning }) {
    this.assertPlain('update');

    const { table, where } = this.query;
    const assignments = parseChanges(table, changes as { set?: Row; inc?: Row });
    if (assignments.length === 0) throw new Error('Nothing to update: both `set` and `inc` are empty');

    const b = renderTable(new SqlBuilder(db.dialect).push('UPDATE '), table).push(' SET ');

    renderAssignments(b, assignments, table[ALIAS]);
    renderWhere(b, where);

    return await runReturning(db, b, table, returning);
  }

  delete(db: IDatabase, options: { returning: true }): Promise<InferForSelect<ColumnsOf<T>>[]>;
  delete<K extends Returnable<T>>(db: IDatabase, options: { returning: K[] }): Promise<Returned<T, K>[]>;
  delete(db: IDatabase, options?: { returning?: false }): Promise<undefined>;
  async delete(db: IDatabase, { returning = false }: { returning?: Returning } = {}) {
    this.assertPlain('delete');

    const { table, where } = this.query;
    const b = renderTable(new SqlBuilder(db.dialect).push('DELETE FROM '), table);

    renderWhere(b, where);

    return await runReturning(db, b, table, returning);
  }

  // every column of the queried table, unless `select` says otherwise
  private fields(): Field[] {
    const { table, select } = this.query;
    return select ?? columnsOf(table).map(col => [col.key, { kind: 'ref', alias: table[ALIAS], col, path: [] }]);
  }

  private join(kind: Join, table: Table, on: Predicate): Query {
    const alias = table[ALIAS];
    if (this.query.scope.has(alias)) throw new Error(`"${alias}" is already part of the query, join it under another alias`);

    const scope = new Map(this.query.scope).set(alias, table);
    const joins = [...this.query.joins, { kind, table, on: assertInScope(scope, on[NODE]) }];

    return { ...this.query, scope, joins };
  }

  private renderSelect(b: SqlBuilder, fields: Field[]) {
    const { table, joins, distinct, where, groupBy, having, orderBy, limit, offset } = this.query;

    b.push(distinct ? 'SELECT DISTINCT ' : 'SELECT ');

    // an empty select list isn't valid SQL, but each matching row still needs
    // an (empty) object
    if (fields.length === 0) b.push('1');
    else b.join(fields, ', ', ([key, node]) => renderNode(b, node).push(' AS ', quote(key)));

    renderTable(b.push(' FROM '), table);
    joins.forEach(join => renderNode(renderTable(b.push(' ', join.kind, ' JOIN '), join.table).push(' ON '), join.on));
    renderWhere(b, where);

    if (groupBy.length > 0) b.push(' GROUP BY ').join(groupBy, ', ', node => renderNode(b, node));
    if (having.length > 0) b.push(' HAVING ').join(having, ' AND ', node => renderNode(b, node));
    if (orderBy.length > 0) b.push(' ORDER BY ').join(orderBy, ', ', ([node, dir]) => renderNode(b, node).push(' ', dir));
    // sqlite requires LIMIT whenever there's an OFFSET, and there's no "no
    // limit" value both sqlite and postgres accept other than a huge number
    if (limit !== undefined || offset !== undefined) b.push(` LIMIT ${limit ?? Number.MAX_SAFE_INTEGER}`);
    if (offset !== undefined) b.push(` OFFSET ${offset}`);

    return b;
  }

  // keeps a `limit(0)`, which can never match
  private top() {
    return this.limit(Math.min(this.query.limit ?? 1, 1));
  }

  // UPDATE/DELETE ... ORDER BY/LIMIT isn't portable, so refuse it rather than
  // silently affecting more rows than the query suggests
  private assertPlain(operation: string) {
    const { joins, select, distinct, groupBy, having, orderBy, limit, offset } = this.query;
    if (joins.length > 0 || select || distinct || groupBy.length > 0 || having.length > 0 || orderBy.length > 0 || limit !== undefined || offset !== undefined) {
      throw new Error(`Cannot ${operation} with joins, select, distinct, groupBy, having, orderBy, limit or offset`);
    }
  }
}

const from = <T extends Table>(table: T) => new QueryBuilder<T>({
  table,
  scope: new Map([[table[ALIAS], table]]),
  joins: [],
  where: [],
  groupBy: [],
  having: [],
  orderBy: [],
});

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
  expr,
  f,
  from,
  into,
  parse,
  types as t,
};
