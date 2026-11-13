import { z } from 'zod/v4';
import { create, defineMigrations, table } from '../src';

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

export const things = table('things', t => ({
  seq: t.sequence().primaryKey(),
  blob: t.binary().nullable(),
  flag: t.boolean().default(false),
  day: t.date(),
  amount: t.decimal(),
  ratio: t.float(),
  big: t.integer(),
  doc: t.json(z.object({ a: z.array(z.number()) })),
  body: t.text().unique(),
  list: t.json(z.array(z.union([z.string(), z.number()]))).default(() => ['x', 1]),
  label: t.citext().nullable(),
}));

export const migrate = defineMigrations({
  '0001': async (db) => {
    await create.table(tasks).onto(db);
    await create.index(tasks, ['status', 'scheduledAt']).onto(db);
  },
  '0002': async (db) => {
    await create.table(things).onto(db);
    await create.uniqueIndex(things, ['day', 'big']).onto(db);
  },
});
