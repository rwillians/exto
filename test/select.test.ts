import { beforeEach, describe, expect, test } from 'bun:test';
import { from, into } from '../src';
import { type Status, type Task, jane, minutesAgo, minutesFromNow, task, tasks, users } from './fixtures';
import { type Database, type Equals, type Expand, assert, suite } from './helpers';

suite('select', (fresh) => {
  let db: Database;
  let sqls: string[];
  let rows: Task[];

  beforeEach(async () => {
    ({ db, sqls } = await fresh());

    rows = await into(tasks).values([
      task({ status: 'scheduled', scheduledTo: minutesAgo(3) }),
      task({ status: 'queued', scheduledTo: minutesAgo(1) }),
      task({ status: 'running', scheduledTo: minutesAgo(2) }),
      task({ status: 'scheduled', scheduledTo: minutesFromNow(1) }),
    ]).insert(db);

    sqls.length = 0;
  });

  const due = () => from(tasks).where(tasks.scheduledTo, '<', new Date());
  const statuses = (rows: { status: Status }[]) => rows.map(row => row.status);

  describe('all', () => {
    test('returns every row', async () => {
      expect(await from(tasks).orderBy([tasks.scheduledTo]).all(db)).toEqual([rows[0]!, rows[2]!, rows[1]!, rows[3]!]);
    });

    test('returns the matching rows', async () => {
      expect(statuses(await due().orderBy([tasks.scheduledTo]).all(db))).toEqual(['scheduled', 'running', 'queued']);
    });

    test('returns an empty list when nothing matches', async () => {
      expect(await from(tasks).where(tasks.status, '=', 'failed').all(db)).toEqual([]);
    });
  });

  describe('one', () => {
    test('returns the first matching row', async () => {
      expect(await due().orderBy([tasks.scheduledTo]).one(db)).toEqual(rows[0]!);
    });

    test('limits the query to 1 row', async () => {
      await due().one(db);

      expect(sqls.at(-1)).toMatch(/ LIMIT 1$/);
    });

    test('returns null when nothing matches', async () => {
      expect(await from(tasks).where(tasks.status, '=', 'failed').one(db)).toBeNull();
    });
  });

  describe('select', () => {
    test('picks columns under keys of their own', async () => {
      const picked = await due().orderBy([tasks.scheduledTo]).select({ id: tasks.id, type: tasks.status }).all(db);

      expect(picked).toEqual([
        { id: rows[0]!.id, type: 'scheduled' },
        { id: rows[2]!.id, type: 'running' },
        { id: rows[1]!.id, type: 'queued' },
      ]);
    });

    test('picks every column of a spread table', async () => {
      expect(await from(tasks).select({ ...tasks }).orderBy([tasks.scheduledTo]).all(db)).toEqual(await from(tasks).orderBy([tasks.scheduledTo]).all(db));
    });

    test('picks a column under many keys', async () => {
      const [row] = await from(tasks).select({ a: tasks.status, b: tasks.status }).orderBy([tasks.scheduledTo]).all(db);

      expect(row).toEqual({ a: 'scheduled', b: 'scheduled' });
    });

    test('picks nested fields', async () => {
      const [row] = await from(tasks).select({ kind: tasks.payload.kind }).all(db);

      expect(row).toEqual({ kind: 'Prune' });
    });

    test('picks nothing given an empty projection', async () => {
      expect(await due().select({}).all(db)).toEqual([{}, {}, {}]);
    });

    test('works with one', async () => {
      expect(await due().orderBy([tasks.scheduledTo]).select({ status: tasks.status }).one(db)).toEqual({ status: 'scheduled' });
    });
  });

  describe('orderBy', () => {
    test('orders by many columns', async () => {
      const ordered = await from(tasks).orderBy([tasks.status, tasks.scheduledTo]).all(db);

      expect(ordered.map(row => row.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[0]!.id, rows[3]!.id]);
    });

    test('orders descending', async () => {
      const ordered = await from(tasks).orderBy([[tasks.scheduledTo, 'DESC']]).all(db);

      expect(ordered).toEqual([rows[3]!, rows[1]!, rows[2]!, rows[0]!]);
    });

    test('puts nulls first or last, as told', async () => {
      await into(users).values([jane, { name: 'John Doe', email: 'john.doe@example.com', lastLoggedInAt: minutesAgo(1) }]).insert(db);
      const names = async (direction: 'ASC NULLS FIRST' | 'ASC NULLS LAST' | 'DESC NULLS FIRST' | 'DESC NULLS LAST') =>
        (await from(users).orderBy([[users.lastLoggedInAt, direction]]).select({ name: users.name }).all(db)).map(row => row.name);

      expect(await names('ASC NULLS FIRST')).toEqual(['Jane Doe', 'John Doe']);
      expect(await names('ASC NULLS LAST')).toEqual(['John Doe', 'Jane Doe']);
      expect(await names('DESC NULLS FIRST')).toEqual(['Jane Doe', 'John Doe']);
      expect(await names('DESC NULLS LAST')).toEqual(['John Doe', 'Jane Doe']);
    });

    test('refuses unknown directions', () => {
      expect(() => from(tasks).orderBy([[tasks.createdAt, 'ASC; DROP TABLE tasks' as never]])).toThrow('Unknown direction "ASC; DROP TABLE tasks"');
    });
  });

  describe('limit and offset', () => {
    test('limit caps the number of rows', async () => {
      expect(await due().orderBy([tasks.scheduledTo]).limit(1).offset(0).all(db)).toEqual([rows[0]!]);
      expect(await due().limit(2).all(db)).toHaveLength(2);
    });

    test('offset skips rows', async () => {
      expect(await due().orderBy([tasks.scheduledTo]).limit(1).offset(1).all(db)).toEqual([rows[2]!]);
      expect(await due().orderBy([tasks.scheduledTo]).offset(2).all(db)).toEqual([rows[1]!]);
    });
  });

  describe('exists', () => {
    test('is true when any row matches', async () => {
      expect(await from(tasks).where(tasks.status, '=', 'queued').exists(db)).toBe(true);
    });

    test('is false when no row matches', async () => {
      expect(await from(tasks).where(tasks.status, '=', 'failed').exists(db)).toBe(false);
    });
  });

  describe('count', () => {
    test('counts the matching rows', async () => {
      expect(await due().count(db)).toBe(3);
      expect(await from(tasks).count(db)).toBe(4);
      expect(await from(tasks).where(tasks.status, '=', 'failed').count(db)).toBe(0);
    });
  });

  describe('distinct', () => {
    test('leaves out duplicate rows', async () => {
      const distinct = await from(tasks).select({ status: tasks.status }).distinct().orderBy([tasks.status]).all(db);

      expect(statuses(distinct)).toEqual(['queued', 'running', 'scheduled']);
    });

    test('counts the distinct rows', async () => {
      expect(await from(tasks).select({ status: tasks.status }).distinct().count(db)).toBe(3);
      expect(await from(tasks).distinct().count(db)).toBe(4);
    });
  });

  test('builders are immutable', async () => {
    const base = from(tasks);

    base.where(tasks.status, '=', 'failed');
    base.limit(1);

    expect(await base.count(db)).toBe(4);
    expect(await base.all(db)).toHaveLength(4);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const c1 = await from(tasks).where(tasks.scheduledTo, '<', new Date()).one(db);
  assert<Equals<typeof c1, Task | null>>();

  const c2 = await from(tasks).where(tasks.scheduledTo, '<', new Date()).orderBy([tasks.scheduledTo]).all(db);
  assert<Equals<typeof c2, Task[]>>();

  const c3 = await from(tasks).select({ id: tasks.id, type: tasks.status }).all(db);
  assert<Equals<typeof c3, { id: string; type: Status }[]>>();

  const c4 = await from(tasks).select({ ...tasks }).all(db);
  assert<Equals<typeof c4, Task[]>>();

  const c5 = await from(tasks).select({}).all(db);
  assert<Equals<typeof c5, {}[]>>();

  const c6 = await from(tasks).limit(1).offset(0).all(db);
  assert<Equals<typeof c6, Task[]>>();

  const nested = await from(tasks).select({ kind: tasks.payload.kind, params: tasks.payload.params }).all(db);
  assert<Equals<typeof nested, { kind: string; params: Record<string, unknown> }[]>>();

  const spreadOne = await from(tasks).select({ ...tasks, parent: tasks.parentId }).one(db);
  assert<Equals<Expand<NonNullable<typeof spreadOne>>, Expand<Task & { parent: string | null }>>>();

  const exists = await from(tasks).exists(db);
  assert<Equals<typeof exists, boolean>>();

  const count = await from(tasks).count(db);
  assert<Equals<typeof count, number>>();

  const distinct = await from(tasks).select({ status: tasks.status }).distinct().all(db);
  assert<Equals<typeof distinct, { status: Status }[]>>();

  // @ts-expect-error projections take references to the query's table only
  from(tasks).select({ id: users.id });

  // @ts-expect-error projections take references, not keys
  from(tasks).select({ id: 'id' });

  // @ts-expect-error orderBy takes references to the query's table only
  from(tasks).orderBy([users.createdAt]);

  from(tasks).orderBy([[tasks.createdAt, 'DESC NULLS LAST']]);

  // @ts-expect-error orderBy directions are ASC or DESC, optionally with NULLS FIRST or LAST
  from(tasks).orderBy([[tasks.createdAt, 'UP']]);
};
