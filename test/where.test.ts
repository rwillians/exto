import { beforeEach, describe, expect, test } from 'bun:test';
import { expr, f, from, into } from '../src';
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

    test('IS NULL and IS NOT NULL', async () => {
      await into(tasks).values(task({ parentId: rows[0]!.id })).insert(db);

      expect(await from(tasks).where(tasks.parentId, 'IS', null).count(db)).toBe(4);
      expect(await from(tasks).where(tasks.parentId, 'IS NOT', null).count(db)).toBe(1);
    });

    test('LIKE and NOT LIKE', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'LIKE', 'sch%').all(db))).toEqual(idsOf(0, 1));
      expect(await ids(from(tasks).where(tasks.status, 'LIKE', 'f_iled').all(db))).toEqual(idsOf(3));
      expect(await ids(from(tasks).where(tasks.status, 'NOT LIKE', '%u%').all(db))).toEqual(idsOf(3));
    });

    test('LIKE on nested fields', async () => {
      expect(await from(tasks).where(tasks.payload.kind, 'LIKE', 'Pr%').count(db)).toBe(4);
      expect(await from(tasks).where(expr(tasks.payload.kind, 'NOT LIKE', 'Pr%')).count(db)).toBe(0);
    });

    test('LIKE takes text columns only', () => {
      expect(() => from(tasks).where(tasks.id, 'LIKE', '01%')).toThrow('"LIKE" only takes text columns, "tasks.id" isn\'t one');
      expect(() => from(tasks).where(tasks.status, 'LIKE', JSON.parse('1'))).toThrow('"LIKE" takes a string pattern, got 1');
    });

    test('compares dates', async () => {
      expect(await ids(from(tasks).where(tasks.scheduledTo, '<', new Date()).all(db))).toEqual(idsOf(0, 3));
    });

    test('ILIKE and NOT ILIKE', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'ILIKE', 'SCH%').all(db))).toEqual(idsOf(0, 1));
      expect(await ids(from(tasks).where(tasks.status, 'NOT ILIKE', 'SCH%').all(db))).toEqual(idsOf(2, 3));
      expect(await from(tasks).where(tasks.payload.kind, 'ILIKE', 'prune').count(db)).toBe(4);
    });

    test('IN and NOT IN', async () => {
      expect(await ids(from(tasks).where(tasks.status, 'IN', ['scheduled', 'queued']).all(db))).toEqual(idsOf(0, 1, 2));
      expect(await ids(from(tasks).where(tasks.status, 'NOT IN', ['scheduled', 'queued']).all(db))).toEqual(idsOf(3));
      expect(await ids(from(tasks).where(tasks.attempts, 'IN', [1, 3]).all(db))).toEqual(idsOf(1, 2, 3));
    });

    test('IN an empty list matches nothing, and NOT IN it matches everything', async () => {
      expect(await from(tasks).where(tasks.status, 'IN', []).count(db)).toBe(0);
      expect(await from(tasks).where(tasks.status, 'NOT IN', []).count(db)).toBe(4);
    });

    test('BETWEEN and NOT BETWEEN, bounds included', async () => {
      expect(await ids(from(tasks).where(tasks.attempts, 'BETWEEN', [1, 3]).all(db))).toEqual(idsOf(1, 2, 3));
      expect(await ids(from(tasks).where(tasks.attempts, 'NOT BETWEEN', [1, 3]).all(db))).toEqual(idsOf(0));
      expect(await ids(from(tasks).where(tasks.scheduledTo, 'BETWEEN', [minutesAgo(2), new Date()]).all(db))).toEqual(idsOf(0, 3));
    });

    test('IS DISTINCT FROM and IS NOT DISTINCT FROM treat nulls as values', async () => {
      const [child] = await into(tasks).values(task({ parentId: rows[0]!.id })).insert(db);
      const parentId = rows[0]!.id;

      // unlike `!=` and `=`, which never match nulls
      expect(await from(tasks).where(tasks.parentId, '!=', parentId).count(db)).toBe(0);
      expect(await from(tasks).where(tasks.parentId, 'IS DISTINCT FROM', parentId).count(db)).toBe(4);
      expect(await ids(from(tasks).where(tasks.parentId, 'IS NOT DISTINCT FROM', parentId).all(db))).toEqual([child!.id]);
      expect(await from(tasks).where(tasks.parentId, 'IS NOT DISTINCT FROM', null).count(db)).toBe(4);
      expect(await from(tasks).where(tasks.parentId, 'IS DISTINCT FROM', tasks.id).count(db)).toBe(5);
    });

    test('reject values of the wrong shape', () => {
      expect(() => from(tasks).where(tasks.status, 'IN', JSON.parse('"queued"'))).toThrow('"IN" takes a list of values, got queued');
      expect(() => from(tasks).where(tasks.attempts, 'BETWEEN', JSON.parse('[1]'))).toThrow('"BETWEEN" takes a [low, high] pair, got [1]');
      expect(() => from(tasks).where(tasks.id, 'ILIKE', 'x')).toThrow('"ILIKE" only takes text columns, "tasks.id" isn\'t one');
      expect(() => from(tasks).where(tasks.status, 'IN', tasks.status as never)).toThrow('"IN" takes a value, not another operand');
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

  test('expr.not negates a condition', async () => {
    const query = from(tasks)
      .where(expr.not(expr.or([expr(tasks.status, '=', 'scheduled'), expr(tasks.status, '=', 'queued')])));

    expect(await ids(query.all(db))).toEqual(idsOf(3));
  });

  test('expr.not binds to the condition it negates', async () => {
    const query = from(tasks)
      .where(expr.not(expr(tasks.status, '=', 'scheduled')))
      .where(expr.not(f`${tasks.attempts} > ${1}`));

    expect(await ids(query.all(db))).toEqual(idsOf(2));
  });

  test('expr.not twice is the condition itself', async () => {
    expect(await ids(from(tasks).where(expr.not(expr.not(expr(tasks.attempts, '=', 3)))).all(db))).toEqual(idsOf(1, 3));
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
    expr(tasks.parentId, 'IS', null),
  ]));

  from(tasks).where(expr.not(expr.and([expr(tasks.status, '=', 'scheduled'), f`${tasks.attempts} > ${1}`])));

  // @ts-expect-error only conditions can be negated
  expr.not(tasks.status);

  // @ts-expect-error negated references must be to the query's table too
  from(tasks).where(expr.not(expr(users.name, '=', 'Jane')));

  // @ts-expect-error enum values are checked
  from(tasks).where(tasks.status, '=', 'nope');

  // @ts-expect-error values must match the column type
  from(tasks).where(tasks.scheduledTo, '<', 'yesterday');

  // @ts-expect-error only nullable columns can be compared with null
  from(tasks).where(tasks.status, 'IS', null);

  // @ts-expect-error references must be to the query's table
  from(tasks).where(users.name, '=', 'Jane');

  // @ts-expect-error compared columns must have compatible types
  from(tasks).where(tasks.attempts, '=', tasks.status);

  // @ts-expect-error LIKE takes string patterns
  from(tasks).where(tasks.status, 'LIKE', 1);

  // @ts-expect-error LIKE takes string values only
  from(tasks).where(tasks.attempts, 'LIKE', '1%');

  // @ts-expect-error LIKE doesn't take dates
  from(tasks).where(tasks.scheduledTo, 'NOT LIKE', '2026%');

  from(tasks).where(expr.or([
    expr(tasks.status, 'IN', ['queued', 'running']),
    expr(tasks.scheduledTo, 'BETWEEN', [new Date(0), new Date()]),
    expr(tasks.parentId, 'IS DISTINCT FROM', tasks.id),
  ]));

  // @ts-expect-error IN checks every value
  from(tasks).where(tasks.status, 'IN', ['queued', 'nope']);

  // @ts-expect-error IN takes a list
  from(tasks).where(tasks.status, 'IN', 'queued');

  // @ts-expect-error BETWEEN takes a pair of the column's type
  from(tasks).where(tasks.attempts, 'BETWEEN', ['1', '3']);

  // @ts-expect-error BETWEEN takes exactly two values
  from(tasks).where(tasks.attempts, 'BETWEEN', [1, 2, 3]);

  // @ts-expect-error ILIKE takes string values only
  from(tasks).where(tasks.attempts, 'ILIKE', '1%');

  // @ts-expect-error IS DISTINCT FROM compares compatible columns
  from(tasks).where(tasks.parentId, 'IS DISTINCT FROM', tasks.attempts);

  // @ts-expect-error only comparisons take another column
  from(tasks).where(tasks.status, 'IN', tasks.status);

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
