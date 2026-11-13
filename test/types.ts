// type-level assertions, checked by `bun check` (never executed)
import { create, from, into, type IDatabase } from '../src';
import { tasks } from './fixtures';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <_ extends true>() => { };

type Status = 'scheduled' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

assert<Equals<typeof tasks.infer, {
  id: string;
  parentId: string | null;
  status: Status;
  type: string;
  payload: Record<string, any>;
  attempts: number;
  createdAt: Date;
  scheduledAt: Date;
}>>();

assert<Equals<typeof tasks.inferForInsert, {
  status: Status;
  type: string;
  payload: Record<string, any>;
  scheduledAt: string | number | Date;
  parentId?: string | null;
  attempts?: number;
  createdAt?: string | number | Date;
}>>();

assert<Equals<keyof typeof tasks.inferForUpdate, 'parentId' | 'status' | 'type' | 'payload' | 'attempts' | 'createdAt' | 'scheduledAt'>>();

export const checks = async (db: IDatabase) => {
  const picked = await from(tasks).select(db, ['id', 'type']);
  assert<Equals<typeof picked, { id: string; type: string }[]>>();

  const pickedNone = await from(tasks).select(db, []);
  assert<Equals<typeof pickedNone, {}[]>>();

  const exists = await from(tasks).where('status', '=', 'queued').exists(db);
  assert<Equals<typeof exists, boolean>>();

  from(tasks).where('parentId', 'is', null).where('status', 'in', ['queued', 'running']);

  const row = { status: 'queued', type: 'a', payload: {}, scheduledAt: new Date() } as const;

  const inserted = await into(tasks).values(row).insert(db);
  assert<Equals<typeof inserted, typeof tasks.infer[]>>();

  const insertedAll = await into(tasks).values(row).insert(db, { returning: true });
  assert<Equals<typeof insertedAll, typeof tasks.infer[]>>();

  const insertedIds = await into(tasks).values(row).insert(db, { returning: ['id'] });
  assert<Equals<typeof insertedIds, { id: string }[]>>();

  const nothing = await into(tasks).values(row).insert(db, { returning: false });
  assert<Equals<typeof nothing, undefined>>();

  const empties = await into(tasks).values(row).insert(db, { returning: [] });
  assert<Equals<typeof empties, {}[]>>();

  // @ts-expect-error returning uses field keys, not column names
  into(tasks).values(row).insert(db, { returning: ['scheduled_at'] });

  const updated = await from(tasks).update(db, { set: { status: 'running' } });
  assert<Equals<typeof updated, typeof tasks.infer[]>>();

  const updatedAll = await from(tasks).update(db, { set: { status: 'running' }, returning: true });
  assert<Equals<typeof updatedAll, typeof tasks.infer[]>>();

  const updatedIds = await from(tasks).update(db, { set: { status: 'running' }, returning: ['id'] });
  assert<Equals<typeof updatedIds, { id: string }[]>>();

  const updatedEmpties = await from(tasks).update(db, { set: { status: 'running' }, returning: [] });
  assert<Equals<typeof updatedEmpties, {}[]>>();

  const updatedNothing = await from(tasks).update(db, { set: { status: 'running' }, returning: false });
  assert<Equals<typeof updatedNothing, undefined>>();

  const deletedNothing = await from(tasks).delete(db);
  assert<Equals<typeof deletedNothing, undefined>>();

  const deleted = await from(tasks).delete(db, { returning: true });
  assert<Equals<typeof deleted, typeof tasks.infer[]>>();

  const deletedIds = await from(tasks).delete(db, { returning: ['id'] });
  assert<Equals<typeof deletedIds, { id: string }[]>>();

  const deletedEmpties = await from(tasks).delete(db, { returning: [] });
  assert<Equals<typeof deletedEmpties, {}[]>>();

  // @ts-expect-error generated columns can't be inserted
  into(tasks).values({ id: 'x', status: 'queued', type: 'a', payload: {}, scheduledAt: new Date() });

  // @ts-expect-error required columns must be present
  into(tasks).values({ status: 'queued', payload: {}, scheduledAt: new Date() });

  // @ts-expect-error enum values are checked
  from(tasks).where('status', '=', 'nope');

  // @ts-expect-error values must match the column type
  from(tasks).where('scheduledAt', '<', 'yesterday');

  // @ts-expect-error unknown columns are rejected
  from(tasks).where('nope', '=', 1);

  // @ts-expect-error only numeric columns can be incremented
  from(tasks).update(db, { inc: { type: 1 } });

  // @ts-expect-error primary keys can't be updated
  from(tasks).update(db, { set: { id: 'x' } });

  // @ts-expect-error index columns use field keys, not column names
  create.index(tasks, ['scheduled_at']);
};
