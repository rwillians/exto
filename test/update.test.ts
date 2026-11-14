import { beforeEach, expect, test } from 'bun:test';
import { from, into } from '../src';
import { type Task, minutesAgo, minutesFromNow, task, tasks } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('update', (fresh) => {
  let db: Database;
  let due: Task;
  let later: Task;

  beforeEach(async () => {
    ({ db } = await fresh());

    [due, later] = (await into(tasks).values([
      task({ scheduledTo: minutesAgo(1), attempts: 1 }),
      task({ scheduledTo: minutesFromNow(1) }),
    ]).insert(db)) as [Task, Task];
  });

  const query = () => from(tasks).where(tasks.scheduledTo, '<', new Date());

  test('sets and increments the matching rows', async () => {
    await query().update(db, { set: { status: 'running' }, inc: { attempts: 1 } });

    expect(await from(tasks).where(tasks.id, '=', due.id).one(db)).toEqual({ ...due, status: 'running', attempts: 2 });
    expect(await from(tasks).where(tasks.id, '=', later.id).one(db)).toEqual(later);
  });

  test('updates every row when unfiltered', async () => {
    await from(tasks).update(db, { set: { status: 'canceled' } });

    expect(await from(tasks).where(tasks.status, '=', 'canceled').count(db)).toBe(2);
  });

  test('sets embedded fields', async () => {
    const [row] = await query().update(db, { set: { payload: { kind: 'Notify', params: { to: 'x' } } } });

    expect(row!.payload).toEqual({ kind: 'Notify', params: { to: 'x' } });
  });

  test('sets optional columns to null', async () => {
    await into(tasks).values(task({ parentId: due.id })).insert(db);

    await from(tasks).update(db, { set: { parentId: null } });

    expect(await from(tasks).where(tasks.parentId, 'is', null).count(db)).toBe(3);
  });

  test('returns every column of the updated rows by default', async () => {
    expect(await query().update(db, { set: { status: 'running' } })).toEqual([{ ...due, status: 'running' }]);
  });

  test('returns every column given returning: true', async () => {
    expect(await query().update(db, { inc: { attempts: 1 }, returning: true })).toEqual([{ ...due, attempts: 2 }]);
  });

  test('returns the given columns', async () => {
    expect(await query().update(db, { set: { status: 'running' }, returning: ['id'] })).toEqual([{ id: due.id }]);
  });

  test('returns an empty object per row given returning: []', async () => {
    expect(await from(tasks).update(db, { set: { status: 'running' }, returning: [] })).toEqual([{}, {}]);
  });

  test('returns undefined given returning: false', async () => {
    expect(await query().update(db, { set: { status: 'running' }, returning: false })).toBeUndefined();
    expect(await from(tasks).where(tasks.status, '=', 'running').count(db)).toBe(1);
  });

  test('returns nothing when nothing matches', async () => {
    expect(await from(tasks).where(tasks.status, '=', 'failed').update(db, { set: { status: 'running' } })).toEqual([]);
  });

  test('validates the values it sets', async () => {
    const set = JSON.parse('{"status":"nope"}');

    await expect(query().update(db, { set })).rejects.toThrow();
    await expect(query().update(db, { set: { attempts: -1 } })).rejects.toThrow();
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const e1 = await from(tasks).update(db, { set: { status: 'running' }, inc: { attempts: 1 } });
  assert<Equals<typeof e1, Task[]>>();

  const e2 = await from(tasks).update(db, { set: { status: 'running' }, returning: true });
  assert<Equals<typeof e2, Task[]>>();

  const e3 = await from(tasks).update(db, { set: { status: 'running' }, returning: ['id'] });
  assert<Equals<typeof e3, Pick<Task, 'id'>[]>>();

  const e4 = await from(tasks).update(db, { set: { status: 'running' }, returning: [] });
  assert<Equals<typeof e4, {}[]>>();

  const e5 = await from(tasks).update(db, { set: { status: 'running' }, returning: false });
  assert<Equals<typeof e5, undefined>>();

  // @ts-expect-error primary keys can't be updated
  from(tasks).update(db, { set: { id: 'x' } });

  // @ts-expect-error unknown columns are rejected
  from(tasks).update(db, { set: { nope: 1 } });

  // @ts-expect-error set values must match the column type
  from(tasks).update(db, { set: { status: 'nope' } });

  // @ts-expect-error only numeric columns can be incremented
  from(tasks).update(db, { inc: { status: 1 } });

  // @ts-expect-error returning takes the table's keys
  from(tasks).update(db, { set: { status: 'running' }, returning: ['nope'] });
};
