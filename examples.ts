import { column, create, defineMigrations, from, into, table } from './src';
import * as sqlite from './src/bun-sqlite';
import { z } from 'zod/v4';

// ─── custom types ────────────────────────────────────────────────────────────

const tc = {
  email: () => column({ type: 'STRING', schema: z.email() }),
};

// ─── schema ──────────────────────────────────────────────────────────────────

type Task = typeof tasks.infer;
type TaskInsert = typeof tasks.inferForInsert;
type TaskUpdate = typeof tasks.inferForUpdate;

const tasks = table('tasks', t => ({
  id: t.uuid().generated().primaryKey(),
  parentId: t.uuid().nullable(),
  status: t.enum(['scheduled', 'queued', 'running', 'succeeded', 'failed', 'canceled']),
  type: t.string({ size: 48 }),
  payload: t.json(z.record(z.string(), z.any())),
  attempts: t.integer().default(0),
  createdAt: t.datetime().default(() => new Date()),
  scheduledAt: t.datetime(),
}));

type User = typeof users.infer;
type UserInsert = typeof users.inferForInsert;
type UserUpdate = typeof users.inferForUpdate;

const users = table('users', t => ({
  id: t.uuid().generated().primaryKey(),
  name: t.string({ size: 48 }),
  email: tc.email(),
  counter: t.integer().default(0),
  createdAt: t.datetime().default(() => new Date()),
}));

// ─── migrations ──────────────────────────────────────────────────────────────

export const migrate = defineMigrations({
  '0001': async (db) => {
    await create.table(tasks).onto(db);
    await create.index(tasks, ['status', 'scheduledAt']).onto(db);
  },
  '0002': async (db) => {
    await create.table(users).onto(db);
    await create.uniqueIndex(users, ['email']).onto(db);
  },
});

// ─── adapter ─────────────────────────────────────────────────────────────────

const db = sqlite.connect(':memory:');
await migrate(db);

// ─── inserts ─────────────────────────────────────────────────────────────────

const a1: Task[] = await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .values([
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
  ])
  .insert(db);

const a2: Task[] = await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .values([
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
  ])
  .insert(db, { returning: true });

const a3: Pick<Task, 'id'>[] = await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .insert(db, { returning: ['id'] });

const a4: {}[] = await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .insert(db, { returning: [] });

const a5: undefined = await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .insert(db, { returning: false });

// ─── on conflict ─────────────────────────────────────────────────────────────

const b1: User[] = await into(users)
  .values({ name: 'Jane Doe 1', email: 'jane.doe@example.com' })
  .insert(db, {
    conflict: { on: ['email'], do: 'nothing' },
  });

const b2: User[] = await into(users)
  .values({ name: 'Jane Doe 2', email: 'jane.doe@example.com' })
  .insert(db, {
    conflict: {
      on: ['email'],
      do: { set: { name: 'Jane Doe 2' }, inc: { counter: 1 } },
    },
  });

const b3: User[] = await into(users)
  .values({ name: 'Jane Doe 3', email: 'jane.doe@example.com' })
  .insert(db, {
    conflict: {
      on: ['email'],
      do: { replace: ['name' /* EXCLUDED.name */], inc: { counter: 1 } },
    },
  });

const b4 = await into(users)
  .values({ name: 'Jane Doe 4', email: 'jane.doe@example.com' })
  .insert(db, { conflict: { on: ['email'], do: 'throw' } })
  .catch(err => err); // will definitely throw

const b5 = await into(users)
  .values({ name: 'Jane Doe 5', email: 'jane.doe@example.com' })
  .insert(db)
  .catch(err => err); // will definitely throw

// for pratical reasons, b5 is exactly the same as b4

// ─── selects ─────────────────────────────────────────────────────────────────

const c1: Task[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .limit(1)
  .offset(0)
  .select(db);

const c2: Task[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .orderBy(['scheduledAt'])
  .select(db);

const c3: Pick<Task, 'id' | 'type'>[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .select(db, ['id', 'type']);

const c4: {}[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .select(db, []);

const c5: boolean = await from(tasks)
  .where('status', '=', 'queued')
  .exists(db);

const c6: boolean = await from(tasks)
  .where('status', '=', 'scheduled')
  .where('scheduledAt', '<', new Date()) // all `.where` params become ANDed together
  .exists(db);

// ─── updates ─────────────────────────────────────────────────────────────────

const d1: Task[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
  });

const d2: Task[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: true,
  });

const d3: Pick<Task, 'id'>[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: ['id'],
  });

const d4: {}[] = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: [],
  });

const d5: undefined = await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: false,
  });

// ─── deletes ─────────────────────────────────────────────────────────────────

const e1: undefined = await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db);

const e2: undefined = await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db, { returning: false });

const e3: Task[] = await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db, { returning: true });

const e4: Pick<Task, 'id'>[] = await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db, { returning: ['id'] });

const e5: {}[] = await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db, { returning: [] });
