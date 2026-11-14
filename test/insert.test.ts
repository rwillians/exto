import { beforeEach, expect, test } from 'bun:test';
import { from, into, parse } from '../src';
import { type Task, task, tasks, users } from './fixtures';
import { type Database, type Equals, UUID_V7, assert, suite } from './helpers';

suite('insert', (fresh) => {
  let db: Database;
  let sqls: string[];

  beforeEach(async () => {
    ({ db, sqls } = await fresh());
  });

  test('inserts every row given to values, across calls', async () => {
    const row = parse(tasks, task());
    const inserted = await into(tasks).values(row).values([row, row]).insert(db);

    expect(inserted).toHaveLength(3);
    expect(await from(tasks).count(db)).toBe(3);
  });

  test('inserts in a single statement', async () => {
    await into(tasks).values(task()).values([task(), task()]).insert(db);

    expect(sqls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1);
  });

  test('returns every column by default', async () => {
    const [row] = await into(tasks).values(task({ status: 'queued' })).insert(db);

    expect(Object.keys(row!).sort()).toEqual(Object.keys(tasks).sort());
    expect(row).toMatchObject({ status: 'queued', parentId: null, attempts: 0, payload: { kind: 'Prune', params: {} } });
    expect(await from(tasks).all(db)).toEqual([row!]);
  });

  test('returns every column given returning: true', async () => {
    const inserted = await into(tasks).values([task(), task()]).insert(db, { returning: true });

    expect(inserted).toHaveLength(2);
    expect(await from(tasks).all(db)).toEqual(expect.arrayContaining(inserted));
  });

  test('returns the given columns, by key or by reference', async () => {
    const inserted = await into(tasks).values([task(), task({ status: 'queued' })]).insert(db, { returning: ['id', tasks.status] });

    expect(inserted).toEqual([
      { id: expect.stringMatching(UUID_V7), status: 'scheduled' },
      { id: expect.stringMatching(UUID_V7), status: 'queued' },
    ]);
  });

  test('returns an empty object per row given returning: []', async () => {
    const inserted = await into(tasks).values([task(), task()]).insert(db, { returning: [] });

    expect(inserted).toEqual([{}, {}]);
  });

  test('returns undefined given returning: false', async () => {
    const inserted = await into(tasks).values([task(), task()]).insert(db, { returning: false });

    expect(inserted).toBeUndefined();
    expect(await from(tasks).count(db)).toBe(2);
  });

  test('generates uuid v7 ids client-side', async () => {
    const before = Date.now();
    const inserted = await into(tasks).values([task(), task(), task()]).insert(db);
    const after = Date.now();

    expect(new Set(inserted.map(row => row.id)).size).toBe(3);

    for (const { id } of inserted) {
      expect(id).toMatch(UUID_V7);
      const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);
    }
  });

  test('inserts nothing given no rows', async () => {
    expect(await into(tasks).values([]).insert(db)).toEqual([]);
    expect(sqls).toEqual([]);
  });

  test('inserts nothing when any row is invalid', async () => {
    const invalid = JSON.parse('{"status":"nope","payload":{"kind":"Prune"},"events":[]}');

    await expect(into(tasks).values([task(), invalid]).insert(db)).rejects.toThrow();
    expect(await from(tasks).count(db)).toBe(0);
  });

  test('inserts into an aliased table', async () => {
    const [row] = await into(tasks.as('t0')).values(task()).insert(db, { returning: ['status'] });

    expect(row).toEqual({ status: 'scheduled' });
  });

  test('is immutable', async () => {
    const base = into(tasks).values(task());

    base.values(task());

    expect(await base.insert(db)).toHaveLength(1);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const a1 = await into(tasks).values(task()).values([task(), task()]).insert(db);
  assert<Equals<typeof a1, Task[]>>();

  const a2 = await into(tasks).values(task()).insert(db, { returning: true });
  assert<Equals<typeof a2, Task[]>>();

  const a3 = await into(tasks).values(task()).insert(db, { returning: ['id', tasks.status] });
  assert<Equals<typeof a3, Pick<Task, 'id' | 'status'>[]>>();

  const a4 = await into(tasks).values(task()).insert(db, { returning: [] });
  assert<Equals<typeof a4, {}[]>>();

  const a5 = await into(tasks).values(task()).insert(db, { returning: false });
  assert<Equals<typeof a5, undefined>>();

  const aliased = await into(tasks.as('t0')).values(task()).insert(db);
  assert<Equals<typeof aliased, Task[]>>();

  // @ts-expect-error generated columns can't be inserted
  into(tasks).values({ ...task(), id: '019a7b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b' });

  // @ts-expect-error required columns must be present
  into(tasks).values({ payload: { kind: 'Prune' }, events: [] });

  // @ts-expect-error required embedded fields must be present
  into(tasks).values({ status: 'queued', payload: {}, events: [] });

  // @ts-expect-error enum values are checked
  into(tasks).values({ ...task(), status: 'nope' });

  // @ts-expect-error unknown columns are rejected
  into(tasks).values({ ...task(), nope: 1 });

  // @ts-expect-error returning takes the table's keys
  into(tasks).values(task()).insert(db, { returning: ['nope'] });

  // @ts-expect-error returning takes the table's column names by key, not by name
  into(tasks).values(task()).insert(db, { returning: ['scheduled_to'] });

  // @ts-expect-error returning takes references to the table only
  into(tasks).values(task()).insert(db, { returning: [users.id] });
};
