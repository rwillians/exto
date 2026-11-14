import { z } from 'zod/v4';
import { type Infer, create, defineMigrations, defineType, embedded, table, t } from '../src';

// ─── custom types ────────────────────────────────────────────────────────────

export const tc = {
  email: () => defineType({ primitive: 'STRING', schema: z.email() }),
};

// ─── schema ──────────────────────────────────────────────────────────────────

export type Status = 'scheduled' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type EventKind = 'scheduled' | 'queued' | 'started' | 'succeeded' | 'failed' | 'canceled' | 'rescued';

export type Task = Infer<'select', typeof tasks>;
export type TaskInsert = Infer<'insert', typeof tasks>;
export type TaskUpdate = Infer<'update', typeof tasks>;

export const tasks = table('tasks', {
  id: t.uuidv7().generated().primaryKey(),
  parentId: t.uuidv7().optional(),
  status: t.enum(['scheduled', 'queued', 'running', 'succeeded', 'failed', 'canceled']),
  attempts: t.integer().unsigned().default(0),
  maxAttempts: t.integer().unsigned().default(3),
  payload: embedded.one({
    kind: t.string(),
    params: t.record().default({}),
  }),
  events: embedded.many({
    kind: t.enum(['scheduled', 'queued', 'started', 'succeeded', 'failed', 'canceled', 'rescued']),
    data: t.record().default({}),
    timestamp: t.timestamp().default(() => new Date()),
  }),
  createdAt: t.timestamp().default(() => new Date()),
  updatedAt: t.timestamp().default(() => new Date()),
  scheduledTo: t.timestamp().default(() => new Date()),
});

export type User = Infer<'select', typeof users>;
export type UserInsert = Infer<'insert', typeof users>;
export type UserUpdate = Infer<'update', typeof users>;

export const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string(),
  email: tc.email(),
  logins: t.integer().unsigned().default(0),
  createdAt: t.timestamp().default(() => new Date()),
  updatedAt: t.timestamp().default(() => new Date()),
  lastLoggedInAt: t.timestamp().optional(),
});

// ─── migrations ──────────────────────────────────────────────────────────────

export const migrate = defineMigrations({
  '0001': async (db) => {
    await create.table(tasks).onto(db);
    await create.index(tasks, ['status', 'scheduledTo']).onto(db);
  },
  '0002': async (db) => {
    await create.table(users).onto(db);
    await create.uniqueIndex(users, ['email']).onto(db);
  },
});

// ─── rows ────────────────────────────────────────────────────────────────────

export const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
export const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000);

// the smallest valid task, overridable field by field
export const task = (overrides: Partial<TaskInsert> = {}): TaskInsert => ({
  status: 'scheduled',
  payload: { kind: 'Prune' },
  events: [{ kind: 'scheduled' }],
  ...overrides,
});

export const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' } satisfies UserInsert;
