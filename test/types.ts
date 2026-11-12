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

  from(tasks).where('parentId', 'is', null).where('status', 'in', ['queued', 'running']);

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
