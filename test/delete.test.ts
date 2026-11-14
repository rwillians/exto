import { beforeEach, expect, test } from 'bun:test';
import { from, into } from '../src';
import { type Task, task, tasks } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('delete', (fresh) => {
  let db: Database;
  let succeeded: Task;
  let queued: Task;

  beforeEach(async () => {
    ({ db } = await fresh());

    [succeeded, queued] = (await into(tasks).values([
      task({ status: 'succeeded' }),
      task({ status: 'queued' }),
    ]).insert(db)) as [Task, Task];
  });

  const query = () => from(tasks).where(tasks.status, '=', 'succeeded');

  test('deletes the matching rows', async () => {
    await query().delete(db);

    expect(await from(tasks).all(db)).toEqual([queued]);
  });

  test('deletes every row when unfiltered', async () => {
    await from(tasks).delete(db);

    expect(await from(tasks).count(db)).toBe(0);
  });

  test('returns undefined by default', async () => {
    expect(await query().delete(db)).toBeUndefined();
  });

  test('returns undefined given returning: false', async () => {
    expect(await query().delete(db, { returning: false })).toBeUndefined();
    expect(await from(tasks).count(db)).toBe(1);
  });

  test('returns every column given returning: true', async () => {
    expect(await query().delete(db, { returning: true })).toEqual([succeeded]);
  });

  test('returns the given columns', async () => {
    expect(await query().delete(db, { returning: ['id'] })).toEqual([{ id: succeeded.id }]);
  });

  test('returns an empty object per row given returning: []', async () => {
    expect(await query().delete(db, { returning: [] })).toEqual([{}]);
  });

  test('returns nothing when nothing matches', async () => {
    expect(await from(tasks).where(tasks.status, '=', 'failed').delete(db, { returning: true })).toEqual([]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const f1 = await from(tasks).delete(db);
  assert<Equals<typeof f1, undefined>>();

  const f2 = await from(tasks).delete(db, { returning: false });
  assert<Equals<typeof f2, undefined>>();

  const f3 = await from(tasks).delete(db, { returning: true });
  assert<Equals<typeof f3, Task[]>>();

  const f4 = await from(tasks).delete(db, { returning: ['id'] });
  assert<Equals<typeof f4, Pick<Task, 'id'>[]>>();

  const f5 = await from(tasks).delete(db, { returning: [] });
  assert<Equals<typeof f5, {}[]>>();

  // @ts-expect-error returning takes the table's keys
  from(tasks).delete(db, { returning: ['nope'] });
};
