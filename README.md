# exto

A teeny tiny, type-safe and zero-dependency ORM for [Bun](https://bun.sh),
with adapters for SQLite and PostgreSQL.

```ts
import { create, from, into, table } from '@rwillians/exto';
import * as sqlite from '@rwillians/exto/bun-sqlite';

const users = table('users', t => ({
  id: t.sequence().primaryKey(),
  name: t.string(),
  email: t.citext().unique(),
  createdAt: t.datetime().default(() => new Date()),
}));

const db = sqlite.connect('./db.sqlite');
await create.table(users, { ifNotExists: true }).onto(db);

await into(users)
  .values({ name: 'Jane Doe', email: 'jane@example.com' })
  .insert(db);

const jane = await from(users)
  .where('email', '=', 'JANE@example.com')
  .select(['id', 'name'])
  .one(db);
// → { id: number, name: string } | null
```

- Keys, operators and values are type-checked and autocompleted.
- Inserted and updated values are validated before any SQL runs.
- No singletons: you always pass the database explicitly.

> [!NOTE]
> exto covers single-table queries for now. See [what's not supported yet](#not-supported-yet).


## Install

```sh
bun add @rwillians/exto
```


## Tables

```ts
import { table } from '@rwillians/exto';
import { z } from 'zod';

const tasks = table('tasks', t => ({
  id: t.uuid().generated().primaryKey(),
  parentId: t.uuid().nullable(),
  status: t.enum(['queued', 'running', 'done']),
  payload: t.json(z.record(z.string(), z.any())),
  attempts: t.integer().default(0),
  scheduledAt: t.datetime(),
}));

type Task = typeof tasks.infer;                // a row
type TaskInsert = typeof tasks.inferForInsert; // what `.values()` takes
type TaskUpdate = typeof tasks.inferForUpdate; // what `set` takes
```

Keys are camelCase in TypeScript and snake_case in the database
(`scheduledAt` → `scheduled_at`).

| builder                            | TS type               | postgres           | sqlite                  |
| :--------------------------------- | :-------------------- | :----------------- | :---------------------- |
| `t.bigint()`                       | `bigint`              | `BIGINT`           | `INTEGER`               |
| `t.binary()`                       | `Uint8Array`          | `BYTEA`            | `BLOB`                  |
| `t.boolean()`                      | `boolean`             | `BOOLEAN`          | `INTEGER`               |
| `t.citext()`                       | `string`              | `CITEXT`           | `TEXT COLLATE NOCASE`   |
| `t.date()`                         | `string` (YYYY-MM-DD) | `DATE`             | `TEXT`                  |
| `t.datetime()`                     | `Date`                | `TIMESTAMPTZ`      | `INTEGER`               |
| `t.decimal({ precision, scale }?)` | `number`              | `NUMERIC(p, s)`    | `NUMERIC`               |
| `t.enum([...values])`              | union of values       | `VARCHAR(n)`       | `TEXT`                  |
| `t.float()`                        | `number`              | `DOUBLE PRECISION` | `REAL`                  |
| `t.integer()`                      | `number`              | `BIGINT`           | `INTEGER`               |
| `t.json(schema)`                   | schema's output       | `JSONB`            | `TEXT`                  |
| `t.sequence()`                     | `number`              | `BIGINT` identity  | `INTEGER` autoincrement |
| `t.string({ size? })`              | `string`              | `VARCHAR(size)`    | `TEXT`                  |
| `t.text()`                         | `string`              | `TEXT`             | `TEXT`                  |
| `t.uuid()`                         | `string`              | `UUID`             | `TEXT`                  |

| modifier        | effect                                          |
| :-------------- | :---------------------------------------------- |
| `.primaryKey()` | primary key                                     |
| `.nullable()`   | accepts `null`, optional on insert              |
| `.default(v)`   | value or function used when omitted on insert   |
| `.unique()`     | unique constraint                               |
| `.generated()`  | value generated on insert (`t.uuid()` → UUIDv7) |

`t.json()` takes any [Standard Schema](https://standardschema.dev) (zod,
valibot, arktype, ...). `t.citext()` needs `CREATE EXTENSION citext` on
postgres (see [`exec`](#migrations)). `t.decimal()` values are JS numbers;
precision and scale only shape postgres' column.

### Custom columns

```ts
import { column } from '@rwillians/exto';

const email = () => column({ type: 'CITEXT', schema: z.email() });

const users = table('users', t => ({
  id: t.sequence().primaryKey(),
  email: email().unique(),
}));
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
    await create.index(tasks, ['status', 'scheduledAt']).onto(db);
  },
});

await migrate(db);
```

Migrations run in key order, each in its own transaction, and only once.


## Insert

```ts
import { into } from '@rwillians/exto';

const row = { status: 'queued', payload: {}, scheduledAt: new Date() } as const;

const inserted: Task[] = await into(tasks)
  .values(row)
  .values([row, row])
  .insert(db);

await into(tasks).values(row).insert(db, { returning: ['id'] }); // → { id: string }[]
await into(tasks).values(row).insert(db, { returning: false });  // → undefined
```

`insert`, `update` and `delete` all take `returning`. It defaults to `true`,
except for `delete`, which defaults to `false`:

| `returning` | result                    |
| :---------- | :------------------------ |
| `true`      | full rows                 |
| `[...keys]` | only those fields         |
| `false`     | `undefined`               |

### On conflict

```ts
const users = table('users', t => ({
  id: t.sequence().primaryKey(),
  email: t.citext().unique(),
  name: t.string(),
  logins: t.integer().default(0),
  banned: t.boolean().default(false),
}));

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

```ts
import { expr, from } from '@rwillians/exto';

const rows: Task[] = await from(tasks)
  .where('status', '=', 'queued')
  .where('scheduledAt', '<', new Date()) // multiple `where`s are ANDed
  .orderBy(['scheduledAt', ['attempts', 'DESC']])
  .limit(10)
  .offset(20)
  .all(db);

const queued = from(tasks).where('status', '=', 'queued');

await queued.one(db);                          // → Task | null (the top row)
await queued.select(['id', 'status']).all(db); // → Pick<Task, 'id' | 'status'>[]
await queued.exists(db);                       // → boolean
await queued.count(db);                        // → number
```

| operator                               | value                      |
| :------------------------------------- | :------------------------- |
| `'='` `'!='` `'<'` `'<='` `'>'` `'>='` | the column's type          |
| `'like'` `'not like'`                  | `string`                   |
| `'in'` `'not in'`                      | array of the column's type |
| `'is'` `'is not'`                      | `null`                     |

### OR and grouping

```ts
await from(tasks)
  .where(expr.or([
    expr('status', '=', 'queued'),
    expr.and([
      expr('status', '=', 'running'),
      expr('attempts', '>', 3),
    ]),
  ]))
  .all(db);
// WHERE ("status" = ? OR ("status" = ? AND "attempts" > ?))
```


## Update

```ts
const updated: Pick<Task, 'id'>[] = await from(tasks)
  .where('status', '=', 'queued')
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: ['id'], // optional, defaults to `true` (full rows)
  });
```


## Delete

```ts
await from(tasks).where('status', '=', 'done').delete(db); // → undefined
await from(tasks).where('status', '=', 'done').delete(db, { returning: true }); // → Task[]
```

`update` and `delete` refuse `orderBy`, `limit` and `offset`, so they never
touch more rows than the query suggests.


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

Rows and changes are validated against the columns before any SQL runs:

```ts
import { ValidationError } from '@rwillians/exto';

const people = table('people', t => ({
  id: t.sequence().primaryKey(),
  name: t.string({ size: 5 }),
  age: t.integer(),
}));

try {
  await into(people).values({ name: 'Jane Doe', age: 1.5 }).insert(db);
} catch (error) {
  if (error instanceof ValidationError) {
    error.message; // Failed validation:
                   //   - 0.name: must be at most 5 characters long
                   //   - 0.age: must be an integer
    error.issues;  // [{ message, path: [0, 'name'] }, ...]
  }
}
```


## Not supported yet

exto is young, and it focuses on queries against a single table. Every query
reads from one table only, so joins aren't possible yet. Neither is nesting one
query inside another, whether as a subquery (`WHERE id IN (SELECT ...)`) or as
a common table expression (`WITH ... SELECT`).

Selects return columns as they're stored: `.select()` takes column keys only,
so computed values such as `attempts * 2` can't be selected. Aggregation stops
at `.count()`, too. There's no `.groupBy()` to group rows, and no `.having()`
to filter those groups.

All of these are planned. Until then, `db.execute()` runs raw SQL and returns
the rows as the driver gives them, without exto's decoding:

```ts
const totals = await db.execute(
  'SELECT status, COUNT(*) AS total FROM tasks GROUP BY status',
  [],
);
```


## License

[MIT](LICENSE)
