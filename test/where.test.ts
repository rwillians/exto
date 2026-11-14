import { beforeEach, describe, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type Task, minutesAgo, minutesFromNow, task, tasks, users } from './fixtures';
import { type Database, assert, type Equals, fresh } from './helpers';

describe('where', () => {
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

    test('compares dates', async () => {
      expect(await ids(from(tasks).where(tasks.scheduledTo, '<', new Date()).all(db))).toEqual(idsOf(0, 3));
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
