// type-level assertions, checked by `bun check` (never executed)
import { create, expr, from, into, t, type IDatabase } from '../src';
import { tasks, things } from './fixtures';

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
  const picked = await from(tasks).select(['id', 'type']).all(db);
  assert<Equals<typeof picked, { id: string; type: string }[]>>();

  const pickedNone = await from(tasks).select([]).all(db);
  assert<Equals<typeof pickedNone, {}[]>>();

  const all = await from(tasks).where('status', '=', 'queued').all(db);
  assert<Equals<typeof all, typeof tasks.infer[]>>();

  const one = await from(tasks).where('status', '=', 'queued').one(db);
  assert<Equals<typeof one, typeof tasks.infer | null>>();

  const pickedOne = await from(tasks).select(['id']).where('status', '=', 'queued').orderBy(['createdAt']).one(db);
  assert<Equals<typeof pickedOne, { id: string } | null>>();

  // @ts-expect-error select uses field keys, not column names
  from(tasks).select(['scheduled_at']);

  const exists = await from(tasks).where('status', '=', 'queued').exists(db);
  assert<Equals<typeof exists, boolean>>();

  const count = await from(tasks).where('status', '=', 'queued').count(db);
  assert<Equals<typeof count, number>>();

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

  const upserted = await into(tasks).values(row).insert(db, { conflict: { on: ['id'], do: { set: { type: 'b' }, inc: { attempts: 1 }, replace: ['status'] } } });
  assert<Equals<typeof upserted, typeof tasks.infer[]>>();

  const upsertedIds = await into(tasks).values(row).insert(db, { conflict: { on: ['id'], do: 'nothing' }, returning: ['id'] });
  assert<Equals<typeof upsertedIds, { id: string }[]>>();

  // @ts-expect-error conflict targets use field keys, not column names
  into(tasks).values(row).insert(db, { conflict: { on: ['scheduled_at'], do: 'nothing' } });

  // @ts-expect-error primary keys can't be replaced
  into(tasks).values(row).insert(db, { conflict: { on: ['id'], do: { replace: ['id'] } } });

  // @ts-expect-error only numeric columns can be incremented
  into(tasks).values(row).insert(db, { conflict: { on: ['id'], do: { inc: { type: 1 } } } });

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

  from(tasks).where(expr.or([
    expr.and([expr('status', '=', 'scheduled'), expr('scheduledAt', '<', new Date())]),
    expr('parentId', 'is', null),
  ]));

  // @ts-expect-error expr checks enum values
  from(tasks).where(expr('status', '=', 'nope'));

  // @ts-expect-error expr checks enum values inside groups
  from(tasks).where(expr.or([expr.and([expr('status', '=', 'nope')])]));

  // @ts-expect-error expr checks values against the column type
  from(tasks).where(expr.and([expr('scheduledAt', '<', 'yesterday')]));

  // @ts-expect-error expr rejects unknown keys
  from(tasks).where(expr.or([expr('nope', '=', 1)]));

  // @ts-expect-error expr uses field keys, not column names
  from(tasks).where(expr('scheduled_at', '<', new Date()));

  // @ts-expect-error unknown columns are rejected
  from(tasks).where('nope', '=', 1);

  // @ts-expect-error only numeric columns can be incremented
  from(tasks).update(db, { inc: { type: 1 } });

  // @ts-expect-error primary keys can't be updated
  from(tasks).update(db, { set: { id: 'x' } });

  // @ts-expect-error index columns use field keys, not column names
  create.index(tasks, ['scheduled_at']);

  assert<Equals<typeof things.infer['huge'], bigint | null>>();

  // @ts-expect-error decimals can't have a scale without a precision
  t.decimal({ scale: 2 });

  // @ts-expect-error decimals can't have a precision without a scale
  t.decimal({ precision: 10 });

  // @ts-expect-error unique index columns use field keys, not column names
  create.uniqueIndex(tasks, ['scheduled_at']);

  const t0 = tasks.as('t0');
  const t1 = tasks.as('t1');

  const aliased = await from(t0).where(t0.status, '=', 'queued').where(t0.createdAt, '<', t0.scheduledAt).all(db);
  assert<Equals<typeof aliased, typeof tasks.infer[]>>();

  const aliasedIds = await from(t0).where('status', '=', 'queued').select(['id']).one(db);
  assert<Equals<typeof aliasedIds, { id: string } | null>>();

  from(t0)
    .where(t0.id, '=', t0.parentId)
    .where(t0.parentId, 'is', null)
    .where(expr.or([expr(t0.status, 'in', ['queued']), expr(t0.attempts, '>', t0.attempts), expr('type', '=', 'a')]))
    .orderBy([t0.createdAt, [t0.scheduledAt, 'DESC'], 'attempts']);

  // @ts-expect-error references must be to the query's alias
  from(t0).where(t1.status, '=', 'queued');

  // @ts-expect-error unaliased queries don't take references to an alias
  from(tasks).where(t0.status, '=', 'queued');

  // @ts-expect-error compared columns must be to the query's alias
  from(t0).where(t0.status, '=', t1.status);

  // @ts-expect-error expr references must be to the query's alias
  from(t0).where(expr.or([expr(t1.status, '=', 'queued')]));

  // @ts-expect-error orderBy references must be to the query's alias
  from(t0).orderBy([t1.createdAt]);

  // @ts-expect-error references check enum values
  from(t0).where(t0.status, '=', 'nope');

  // @ts-expect-error compared columns must have compatible types
  from(t0).where(t0.attempts, '=', t0.status);

  // @ts-expect-error only comparisons take another column
  from(t0).where(t0.type, 'like', t0.status);

  // @ts-expect-error expr checks compared columns' types too
  from(t0).where(expr(t0.createdAt, '<', t0.attempts));
};
