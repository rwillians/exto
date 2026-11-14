# exto

A teeny tiny, type-safe query builder for [Bun](https://bun.sh), with
adapters for SQLite and PostgreSQL.

```ts
import { create, from, into, table, t } from '@rwillians/exto';
import * as sqlite from '@rwillians/exto/bun-sqlite';

const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string(),
  email: t.citext().unique(),
  createdAt: t.timestamp().default(() => new Date()),
});

const db = sqlite.connect('./db.sqlite');
await create.table(users, { ifNotExists: true }).onto(db);

await into(users)
  .values({ name: 'Jane Doe', email: 'jane@example.com' })
  .insert(db);

const jane = await from(users)
  .where(users.email, '=', 'JANE@example.com')
  .select({ id: users.id, name: users.name })
  .one(db);
// → { id: string, name: string } | null
```

- Columns, operators and values are type-checked and autocompleted.
- Values are validated before any SQL runs.
- No singletons: you always pass the database explicitly.


## Install

```sh
bun add @rwillians/exto
```


## Connecting

```ts
import * as sqlite from '@rwillians/exto/bun-sqlite';
import * as pg from '@rwillians/exto/bun-postgres';

const db = sqlite.connect(':memory:');
const db = pg.connect('postgres://user:pass@localhost:5432/app');

// log every statement
const db = sqlite.connect(':memory:', { loggers: [console] });
```


## Tables

```ts
import { embedded, table, t, type Infer } from '@rwillians/exto';

const tasks = table('tasks', {
  id: t.uuidv7().generated().primaryKey(),
  parentId: t.uuidv7().optional(),
  status: t.enum(['queued', 'running', 'done']),
  attempts: t.integer().unsigned().default(0),
  maxAttempts: t.integer().unsigned().default(3),
  payload: embedded.one({
    kind: t.string(),
    params: t.record().default({}),
  }),
  events: embedded.many({
    kind: t.string(),
    timestamp: t.timestamp().default(() => new Date()),
  }),
  scheduledTo: t.timestamp().default(() => new Date()),
});

type Task = Infer<'select', typeof tasks>;       // a row
type TaskInsert = Infer<'insert', typeof tasks>; // what `.values()` takes
type TaskUpdate = Infer<'update', typeof tasks>; // what `set` takes
```

Keys are camelCase in TypeScript and snake_case in the database
(`scheduledTo` → `scheduled_to`).

| builder                            | TS type                   | postgres           | sqlite                  |
| :--------------------------------- | :------------------------ | :----------------- | :---------------------- |
| `t.bigint()`                       | `bigint`                  | `BIGINT`           | `INTEGER`               |
| `t.binary()`                       | `Uint8Array`              | `BYTEA`            | `BLOB`                  |
| `t.boolean()`                      | `boolean`                 | `BOOLEAN`          | `INTEGER`               |
| `t.citext()`                       | `string`                  | `CITEXT`           | `TEXT COLLATE NOCASE`   |
| `t.date()`                         | `string` (YYYY-MM-DD)     | `DATE`             | `TEXT`                  |
| `t.decimal({ precision, scale }?)` | `number`                  | `NUMERIC(p, s)`    | `NUMERIC`               |
| `t.enum([...values])`              | union of values           | `VARCHAR(n)`       | `TEXT`                  |
| `t.float()`                        | `number`                  | `DOUBLE PRECISION` | `REAL`                  |
| `t.integer()`                      | `number`                  | `BIGINT`           | `INTEGER`               |
| `t.json(schema)`                   | schema's output           | `JSONB`            | `TEXT`                  |
| `t.record()`                       | `Record<string, unknown>` | `JSONB`            | `TEXT`                  |
| `t.sequence()`                     | `number`                  | `BIGINT` identity  | `INTEGER` autoincrement |
| `t.string({ size? })`              | `string`                  | `VARCHAR(size)`    | `TEXT`                  |
| `t.text()`                         | `string`                  | `TEXT`             | `TEXT`                  |
| `t.timestamp()`                    | `Date`                    | `TIMESTAMPTZ`      | `INTEGER`               |
| `t.uuidv7()`                       | `string`                  | `UUID`             | `TEXT`                  |
| `embedded.one({ ... })`            | an object                 | `JSONB`            | `TEXT`                  |
| `embedded.many({ ... })`           | an array of objects       | `JSONB`            | `TEXT`                  |

| modifier        | effect                                        |
| :-------------- | :-------------------------------------------- |
| `.primaryKey()` | primary key                                   |
| `.optional()`   | accepts `null`, optional on insert            |
| `.default(v)`   | value or function used when omitted on insert |
| `.unique()`     | unique constraint                             |
| `.generated()`  | a UUIDv7 generated on insert (`t.uuidv7()`)   |
| `.unsigned()`   | rejects negatives (`t.integer()`)             |

`t.json()` takes any [Standard Schema](https://standardschema.dev) (zod,
valibot, arktype, ...). `t.citext()` needs `CREATE EXTENSION citext` on
postgres (see [migrations](#migrations)).

### Custom types

```ts
import { defineType } from '@rwillians/exto';
import { z } from 'zod';

const email = () => defineType({ primitive: 'STRING', schema: z.email() });

const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  email: email(),
});
```


## Migrations

```ts
import { create, defineMigrations, exec } from '@rwillians/exto';

const migrate = defineMigrations({
  '0001': async (db) => {
    if (db.dialect.name === 'postgres') await exec(db, 'CREATE EXTENSION IF NOT EXISTS citext');
    await create.table(users).onto(db);
    await create.uniqueIndex(users, ['email']).onto(db);
  },
  '0002': async (db) => {
    await create.table(tasks).onto(db);
    await create.index(tasks, ['status', 'scheduledTo']).onto(db);
  },
});

await migrate(db);
```

Migrations run in key order, each in its own transaction, and only once:
applied ones are tracked in the `schema_migrations` table.


## Insert

```ts
import { into, parse } from '@rwillians/exto';

const task: TaskInsert = { status: 'queued', payload: { kind: 'Prune' }, events: [] };

const inserted: Task[] = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db);

await into(tasks).values(task).insert(db, { returning: ['id', tasks.status] }); // → Pick<Task, 'id' | 'status'>[]
await into(tasks).values(task).insert(db, { returning: false });                // → undefined

// validate untrusted input, filling in defaults
const row: TaskInsert = parse(tasks, JSON.parse(body));
```

`insert`, `update` and `delete` all take `returning`. It defaults to `true`,
except for `delete`, which defaults to `false`:

| `returning`            | result      |
| :--------------------- | :---------- |
| `true`                 | full rows   |
| `[...keys or columns]` | only those  |
| `false`                | `undefined` |

### On conflict

```ts
const rows = [{ email: 'jane@example.com', name: 'Jane' }];

// skip rows that conflict
await into(users).values(rows).insert(db, {
  conflict: { on: ['email'], do: 'nothing' },
});

// update the existing row
await into(users).values(rows).insert(db, {
  conflict: {
    on: ['email'],
    do: {
      set: { banned: false }, // a given value
      inc: { logins: 1 },     // an increment
      replace: ['name'],      // the value being inserted
    },
  },
});

// throw, same as no `conflict` at all
await into(users).values(rows).insert(db, {
  conflict: { on: ['email'], do: 'throw' },
});
```


## Select

A table is shaped like its columns: `tasks.status` references a column.

```ts
import { expr, from } from '@rwillians/exto';

const due: Task[] = await from(tasks)
  .where(tasks.status, '=', 'queued')
  .where(tasks.scheduledTo, '<', new Date()) // multiple `where`s are ANDed
  .orderBy([tasks.scheduledTo, [tasks.attempts, 'DESC']])
  .limit(10)
  .offset(20)
  .all(db);

const queued = from(tasks).where(tasks.status, '=', 'queued');

await queued.one(db);    // → Task | null
await queued.exists(db); // → boolean
await queued.count(db);  // → number
```

| operator                                      | value                                                   |
| :-------------------------------------------- | :------------------------------------------------------ |
| `'='` `'!='` `'<'` `'<='` `'>'` `'>='`        | the column's type, or another column                    |
| `'IS DISTINCT FROM'` `'IS NOT DISTINCT FROM'` | like `'!='` and `'='`, but `null` is a value too        |
| `'IN'` `'NOT IN'`                             | a list of the column's type                             |
| `'BETWEEN'` `'NOT BETWEEN'`                   | a `[low, high]` pair, both included                     |
| `'LIKE'` `'NOT LIKE'`                         | a `string` pattern (text columns)                       |
| `'ILIKE'` `'NOT ILIKE'`                       | a case-insensitive `string` pattern (text columns)      |
| `'IS'` `'IS NOT'`                             | `null` (optional columns), `true` or `false` (booleans) |

`LIKE` is case-sensitive on postgres (except for `t.citext()` columns), and
case-insensitive for ASCII letters on sqlite. Use `ILIKE` to ignore case on
both.

### Picking columns

```ts
await from(tasks).select({ id: tasks.id, when: tasks.scheduledTo }).all(db);
// → { id: string, when: Date }[]

await from(tasks).select({ ...tasks, parent: tasks.parentId }).all(db);
// → (Task & { parent: string | null })[]
```

### Comparing columns

```ts
await from(tasks).where(tasks.attempts, '<', tasks.maxAttempts).all(db);
```

### OR and grouping

```ts
await from(tasks)
  .where(expr.or([
    expr(tasks.status, '=', 'queued'),
    expr.and([
      expr(tasks.status, '=', 'running'),
      expr(tasks.attempts, '>', 3),
    ]),
  ]))
  .all(db);
```

### Embedded fields

Fields of `embedded.one()` columns are referenced like columns:

```ts
await from(tasks)
  .where(tasks.payload.kind, '=', 'Prune')
  .select({ kind: tasks.payload.kind, params: tasks.payload.params })
  .all(db);
// → { kind: string, params: Record<string, unknown> }[]
```

### Raw SQL fragments

```ts
import { f } from '@rwillians/exto';

await from(tasks).where(f`upper(${tasks.payload.kind})`, '=', 'PRUNE').all(db);
```

A fragment can also be a condition of its own, to use any operator your
database has, e.g. postgres' JSON containment and regular expressions:

```ts
await from(tasks).where(f`${tasks.payload} @> ${{ kind: 'Prune' }}`).all(db);

await from(tasks)
  .where(expr.or([
    f`${tasks.payload.kind} ~ ${'^N'}`,
    expr(tasks.status, '=', 'queued'),
  ]))
  .all(db);
```

Interpolated columns are rendered in place, and any other value is passed as
a parameter.


## Group by

```ts
await from(tasks)
  .where(tasks.status, '!=', 'queued')
  .groupBy([tasks.status])
  .select({
    status: tasks.status,
    tasks: expr.count(tasks.id),
    attempts: expr.sum(tasks.attempts),
  })
  .all(db);
// → { status: Task['status'], tasks: number, attempts: number }[]
```


## Joins

Alias a table to query it more than once:

```ts
const parent = tasks.as('parent');
const child = tasks.as('child');

await from(parent)
  .leftJoin(child, expr(parent.id, '=', child.parentId))
  .where(parent.parentId, 'IS', null)
  .groupBy([parent.id])
  .select({ ...parent, children: expr.count(child.id) })
  .all(db);
// → (Task & { children: number })[]
```

`expr.aggregate()` collects a table's rows in each group into a list, or
just the columns you pick:

```ts
await from(parent)
  .leftJoin(child, expr(parent.id, '=', child.parentId))
  .where(parent.parentId, 'IS', null)
  .groupBy([parent.id])
  .select({
    ...parent,
    children: expr.aggregate(child),
    summary: expr.aggregate({ id: child.id, kind: child.payload.kind }),
  })
  .all(db);
// → (Task & { children: Task[], summary: { id: string, kind: string }[] })[]
```

A parent without children gets an empty list.

Columns of a left-joined table are nullable: selecting `child.id` gives
`string | null`. A query only takes columns of the tables it reads from, so
referencing `child` before joining it is a type error.


## Update

```ts
const updated: Pick<Task, 'id'>[] = await from(tasks)
  .where(tasks.status, '=', 'queued')
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: ['id'], // optional, defaults to `true` (full rows)
  });
```


## Delete

```ts
await from(tasks).where(tasks.status, '=', 'done').delete(db);                      // → undefined
await from(tasks).where(tasks.status, '=', 'done').delete(db, { returning: true }); // → Task[]
```

`update` and `delete` refuse joins, `groupBy`, `orderBy`, `limit` and
`offset`, so they never touch more rows than the query suggests.


## Transactions

```ts
await db.transaction(async (tx) => {
  await into(users).values({ email: 'jane@example.com', name: 'Jane' }).insert(tx);

  await tx.transaction(async (savepoint) => {
    // nested transactions use savepoints
  });
});
```

The transaction rolls back if the callback throws.


## Validation

```ts
import { ValidationError } from '@rwillians/exto';

const people = table('people', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string({ size: 5 }),
  age: t.integer(),
});

try {
  await into(people).values({ name: 'Jane Doe', age: 1.5 }).insert(db);
} catch (error) {
  if (error instanceof ValidationError) {
    error.message; // Failed validation:
                   //   - name: must be at most 5 characters long
                   //   - age: must be an integer
    error.issues;  // [{ message, path: ['name'] }, ...]
  }
}
```


## License

[MIT](LICENSE)
