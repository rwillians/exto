import { create, defineMigrations, from, into, table } from './src';
import * as sqlite from './src/bun-sqlite';
import { z } from 'zod/v4';

export type Task = typeof tasks.infer;
export type TaskInsert = typeof tasks.inferForInsert;
export type TaskUpdate = typeof tasks.inferForUpdate;

export const tasks = table('tasks', t => ({
  id: t.uuid().generated().primaryKey(),
  parentId: t.uuid().nullable(),
  status: t.enum(['scheduled', 'queued', 'running', 'succeeded', 'failed', 'canceled']),
  type: t.string({ size: 48 }),
  payload: t.json(z.record(z.string(), z.any())),
  attempts: t.integer().default(0),
  created_at: t.datetime().default(() => new Date()),
  scheduled_at: t.datetime(),
}));

export const migrate = defineMigrations({
  '0001': async (db) => {
    await create.table(tasks).onto(db);
    await create.index(tasks, ['status', 'scheduledAt']).onto(db);
  },
});

const db = sqlite.connect(':memory:');
await migrate(db);

await into(tasks)
  .values({ status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() })
  .values([
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
    { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date() },
  ])
  .insert(db);

await from(tasks)
  .where('scheduledAt', '<', new Date())
  .limit(1)
  .offset(0)
  .select(db);

await from(tasks)
  .where('scheduledAt', '<', new Date())
  .orderBy(['scheduledAt'])
  .select(db);

await from(tasks)
  .where('scheduledAt', '<', new Date())
  .select(db, ['id', 'type']);

await from(tasks)
  .where('scheduledAt', '<', new Date())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
  });

await from(tasks.as('t'))
  .where('status', '=', 'succeeded')
  .delete(db);
