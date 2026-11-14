import { beforeEach, describe, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type Task, minutesAgo, minutesFromNow, task, tasks, users } from './fixtures';
import { type Database, assert, type Equals, suite } from './helpers';

suite('where', (fresh) => {
  let db: Database;
  let rows: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());

    rows = await into(tasks).values([
      task({ status: 'scheduled', scheduledTo: minutesAgo(1) }),
      task({ status: 'scheduled', scheduledTo: minutesFromNow(1), attempts: 3 }),
      task({ status: 'queued', scheduledTo: minutesFromNow(1), attempts: 1 }),
      task({ status: 'failed', scheduledTo: minutesAgo(1), attempts: 3 }),
    ]).insert(db);
  });

  const ids = async (rows: Promise<Task[]>) => (await rows).map(row => row.id).sort();
  const idsOf = (...indexes: number[]) => indexes.map(i => rows[i]!.id).sort();

  describe('operators', () => {
    test('=', async () => {
      expect(await ids(from(tasks).where(tasks.status, '=', 'scheduled').all(db))).toEqual(idsOf(0, 1));
    });

    test('!=', async () => {
      expect(await ids(from(tasks).where(tasks.status, '!=', 'scheduled').all(db))).toEqual(idsOf(2, 3));
    });

    test('<, <=, > and >=', async () => {
      expect(await ids(from(tasks).where(tasks.attempts, '<', 3).all(db))).toEqual(idsOf(0, 2));
      expect(await ids(from(tasks).where(tasks.attempts, '<=', 1).all(db))).toEqual(idsOf(0, 2));
      expect(await ids(from(tasks).where(tasks.attempts, '>', 1).all(db))).toEqual(idsOf(1, 3));
      expect(await ids(from(tasks).where(tasks.attempts, '>=', 1).all(db))).toEqual(idsOf(1, 2, 3));
    });

    test('is null and is not null', async () => {
      await into(tasks).values(task({ parentId: rows[0]!.id })).insert(db);

      expect(await from(tasks).where(tasks.parentId, 'is', null).count(db)).toBe(4);
      expect(await from(tasks).where(tasks.parentId, 'is not', null).count(db)).toBe(1);
    });

    test('like and not like', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'like', 'sch%').all(db))).toEqual(idsOf(0, 1));
      expect(await ids(from(tasks).where(tasks.status, 'like', 'f_iled').all(db))).toEqual(idsOf(3));
      expect(await ids(from(tasks).where(tasks.status, 'not like', '%u%').all(db))).toEqual(idsOf(3));
    });

    test('like on nested fields', async () => {
      expect(await from(tasks).where(tasks.payload.kind, 'like', 'Pr%').count(db)).toBe(4);
      expect(await from(tasks).where(expr(tasks.payload.kind, 'not like', 'Pr%')).count(db)).toBe(0);
    });

    test('like takes text columns only', () => {
      expect(() => from(tasks).where(tasks.id, 'like', '01%')).toThrow('"like" only takes text columns, "tasks.id" isn\'t one');
      expect(() => from(tasks).where(tasks.status, 'like', JSON.parse('1'))).toThrow('"like" takes a string pattern, got 1');
    });

    test('compares dates', async () => {
      expect(await ids(from(tasks).where(tasks.scheduledTo, '<', new Date()).all(db))).toEqual(idsOf(0, 3));
    });

    test('ilike and not ilike', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'ilike', 'SCH%').all(db))).toEqual(idsOf(0, 1));
      expect(await ids(from(tasks).where(tasks.status, 'not ilike', 'SCH%').all(db))).toEqual(idsOf(2, 3));
      expect(await from(tasks).where(tasks.payload.kind, 'ilike', 'prune').count(db)).toBe(4);
    });

    test('in and not in', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'in', ['scheduled', 'queued']).all(db))).toEqual(idsOf(0, 1, 2));
      expect(await ids(from(tasks).where(tasks.status, 'not in', ['scheduled', 'queued']).all(db))).toEqual(idsOf(3));
      expect(await ids(from(tasks).where(tasks.attempts, 'in', [1, 3]).all(db))).toEqual(idsOf(1, 2, 3));
    });

    test('in an empty list matches nothing, and not in it matches everything', async () => {
      expect(await from(tasks).where(tasks.status, 'in', []).count(db)).toBe(0);
      expect(await from(tasks).where(tasks.status, 'not in', []).count(db)).toBe(4);
    });

    test('between and not between, bounds included', async () => {
      expect(await ids(from(tasks).where(tasks.attempts, 'between', [1, 3]).all(db))).toEqual(idsOf(1, 2, 3));
      expect(await ids(from(tasks).where(tasks.attempts, 'not between', [1, 3]).all(db))).toEqual(idsOf(0));
      expect(await ids(from(tasks).where(tasks.scheduledTo, 'between', [minutesAgo(2), new Date()]).all(db))).toEqual(idsOf(0, 3));
    });

    test('is distinct from and is not distinct from treat nulls as values', async () => {
      const [child] = await into(tasks).values(task({ parentId: rows[0]!.id })).insert(db);
      const parentId = rows[0]!.id;

      // unlike `!=` and `=`, which never match nulls
      expect(await from(tasks).where(tasks.parentId, '!=', parentId).count(db)).toBe(0);
      expect(await from(tasks).where(tasks.parentId, 'is distinct from', parentId).count(db)).toBe(4);
      expect(await ids(from(tasks).where(tasks.parentId, 'is not distinct from', parentId).all(db))).toEqual([child!.id]);
      expect(await from(tasks).where(tasks.parentId, 'is not distinct from', null).count(db)).toBe(4);
      expect(await from(tasks).where(tasks.parentId, 'is distinct from', tasks.id).count(db)).toBe(5);
    });

    test('reject values of the wrong shape', () => {
      expect(() => from(tasks).where(tasks.status, 'in', JSON.parse('"queued"'))).toThrow('"in" takes a list of values, got queued');
      expect(() => from(tasks).where(tasks.attempts, 'between', JSON.parse('[1]'))).toThrow('"between" takes a [low, high] pair, got [1]');
      expect(() => from(tasks).where(tasks.id, 'ilike', 'x')).toThrow('"ilike" only takes text columns, "tasks.id" isn\'t one');
      expect(() => from(tasks).where(tasks.status, 'in', tasks.status as never)).toThrow('"in" takes a value, not another operand');
    });
  });

  test('ANDs every where together', async () => {
    const query = from(tasks)
      .where(tasks.status, '=', 'scheduled')
      .where(tasks.scheduledTo, '<', new Date());

    expect(await ids(query.all(db))).toEqual(idsOf(0));
    expect(await query.exists(db)).toBe(true);
  });

  test('expr.and ANDs expressions together', async () => {
    const query = from(tasks).where(expr.and([
      expr(tasks.status, '=', 'scheduled'),
      expr(tasks.scheduledTo, '<', new Date()),
    ]));

    expect(await ids(query.all(db))).toEqual(idsOf(0));
  });

  test('expr.or ORs expressions together', async () => {
    const query = from(tasks).where(expr.or([
      expr.and([
        expr(tasks.status, '=', 'scheduled'),
        expr(tasks.scheduledTo, '<', new Date()),
      ]),
      expr(tasks.status, '=', 'queued'),
    ]));

    expect(await ids(query.all(db))).toEqual(idsOf(0, 2));
  });

  test('expr.or binds tighter than the where it is ANDed with', async () => {
    const query = from(tasks)
      .where(tasks.attempts, '=', 3)
      .where(expr.or([expr(tasks.status, '=', 'scheduled'), expr(tasks.status, '=', 'queued')]));

    expect(await ids(query.all(db))).toEqual(idsOf(1));
  });

  test('compares a column with another', async () => {
    expect(await ids(from(tasks).where(tasks.attempts, '=', tasks.maxAttempts).all(db))).toEqual(idsOf(1, 3));
    expect(await ids(from(tasks).where(tasks.attempts, '<', tasks.maxAttempts).all(db))).toEqual(idsOf(0, 2));
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const d1 = await from(tasks).where(tasks.status, '=', 'queued').exists(db);
  assert<Equals<typeof d1, boolean>>();

  from(tasks).where(expr.or([
    expr.and([expr(tasks.status, '=', 'scheduled'), expr(tasks.scheduledTo, '<', new Date())]),
    expr(tasks.parentId, 'is', null),
  ]));

  // @ts-expect-error enum values are checked
  from(tasks).where(tasks.status, '=', 'nope');

  // @ts-expect-error values must match the column type
  from(tasks).where(tasks.scheduledTo, '<', 'yesterday');

  // @ts-expect-error only nullable columns can be compared with null
  from(tasks).where(tasks.status, 'is', null);

  // @ts-expect-error references must be to the query's table
  from(tasks).where(users.name, '=', 'Jane');

  // @ts-expect-error compared columns must have compatible types
  from(tasks).where(tasks.attempts, '=', tasks.status);

  // @ts-expect-error like takes string patterns
  from(tasks).where(tasks.status, 'like', 1);

  // @ts-expect-error like takes string values only
  from(tasks).where(tasks.attempts, 'like', '1%');

  // @ts-expect-error like doesn't take dates
  from(tasks).where(tasks.scheduledTo, 'not like', '2026%');

  from(tasks).where(expr.or([
    expr(tasks.status, 'in', ['queued', 'running']),
    expr(tasks.scheduledTo, 'between', [new Date(0), new Date()]),
    expr(tasks.parentId, 'is distinct from', tasks.id),
  ]));

  // @ts-expect-error in checks every value
  from(tasks).where(tasks.status, 'in', ['queued', 'nope']);

  // @ts-expect-error in takes a list
  from(tasks).where(tasks.status, 'in', 'queued');

  // @ts-expect-error between takes a pair of the column's type
  from(tasks).where(tasks.attempts, 'between', ['1', '3']);

  // @ts-expect-error between takes exactly two values
  from(tasks).where(tasks.attempts, 'between', [1, 2, 3]);

  // @ts-expect-error ilike takes string values only
  from(tasks).where(tasks.attempts, 'ilike', '1%');

  // @ts-expect-error is distinct from compares compatible columns
  from(tasks).where(tasks.parentId, 'is distinct from', tasks.attempts);

  // @ts-expect-error only comparisons take another column
  from(tasks).where(tasks.status, 'in', tasks.status);

  // @ts-expect-error unknown operators are rejected
  from(tasks).where(tasks.attempts, '~', 1);

  // @ts-expect-error expr checks enum values
  from(tasks).where(expr(tasks.status, '=', 'nope'));

  // @ts-expect-error expr checks enum values inside groups
  from(tasks).where(expr.or([expr.and([expr(tasks.status, '=', 'nope')])]));

  // @ts-expect-error expr checks values against the column type
  from(tasks).where(expr.and([expr(tasks.scheduledTo, '<', 'yesterday')]));

  // @ts-expect-error expr references must be to the query's table
  from(tasks).where(expr.or([expr(users.name, '=', 'Jane')]));
};
