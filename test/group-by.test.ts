import { beforeEach, expect, test } from 'bun:test';
import { expr, from, into, t, table } from '../src';
import { type Status, type Task, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('group by', (fresh) => {
  let db: Database;
  let inserted: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());

    inserted = await into(tasks).values([
      task({ status: 'scheduled', payload: { kind: 'Prune' }, scheduledTo: minutesAgo(5) }),
      task({ status: 'failed', payload: { kind: 'Prune' }, attempts: 3, scheduledTo: minutesAgo(4) }),
      task({ status: 'failed', payload: { kind: 'Notify' }, attempts: 2, scheduledTo: minutesAgo(3) }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1, scheduledTo: minutesAgo(2) }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1, scheduledTo: minutesAgo(1) }),
    ]).insert(db);
  });

  test('counts rows per nested field', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.payload.kind])
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, count: expr.count(tasks.id) })
      .all(db);

    expect(rows).toEqual([
      { kind: 'Notify', count: 3 },
      { kind: 'Prune', count: 2 },
    ]);
  });

  test('sums a column per group, after filtering', async () => {
    const rows = await from(tasks)
      .where(tasks.status, '!=', 'scheduled')
      .groupBy([tasks.status])
      .orderBy([tasks.status])
      .select({ status: tasks.status, attempts: expr.sum(tasks.attempts) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', attempts: 5 },
      { status: 'succeeded', attempts: 2 },
    ]);
  });

  test('groups by many columns', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status, tasks.payload.kind])
      .orderBy([tasks.status, tasks.payload.kind])
      .select({ status: tasks.status, kind: tasks.payload.kind, count: expr.count(tasks.id) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', kind: 'Notify', count: 1 },
      { status: 'failed', kind: 'Prune', count: 1 },
      { status: 'scheduled', kind: 'Prune', count: 1 },
      { status: 'succeeded', kind: 'Notify', count: 2 },
    ]);
  });

  test('aggregates every row without a group by', async () => {
    const rows = await from(tasks).select({ count: expr.count(tasks.id), attempts: expr.sum(tasks.attempts) }).all(db);

    expect(rows).toEqual([{ count: 5, attempts: 7 }]);
  });

  test('counts and sums each value once, given distinct', async () => {
    const row = await from(tasks)
      .select({
        kinds: expr.count.distinct(tasks.payload.kind),
        statuses: expr.count.distinct(tasks.status),
        attempts: expr.sum.distinct(tasks.attempts),
      })
      .one(db);

    expect(row).toEqual({ kinds: 2, statuses: 3, attempts: 6 });
  });

  test('picks the lowest and highest values per group', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.payload.kind])
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, min: expr.min(tasks.attempts), max: expr.max(tasks.attempts) })
      .all(db);

    expect(rows).toEqual([
      { kind: 'Notify', min: 1, max: 2 },
      { kind: 'Prune', min: 0, max: 3 },
    ]);
  });

  test('picks the lowest and highest timestamps, nested fields and text', async () => {
    const row = await from(tasks)
      .select({
        first: expr.min(tasks.scheduledTo),
        last: expr.max(tasks.scheduledTo),
        kind: expr.min(tasks.payload.kind),
        status: expr.max(tasks.status),
      })
      .one(db);

    expect(row).toEqual({ first: inserted[0]!.scheduledTo, last: inserted[4]!.scheduledTo, kind: 'Notify', status: 'succeeded' });
  });

  test('picks null out of no rows', async () => {
    const row = await from(tasks)
      .where(tasks.status, '=', 'canceled')
      .select({ min: expr.min(tasks.attempts), max: expr.max(tasks.scheduledTo) })
      .one(db);

    expect(row).toEqual({ min: null, max: null });
  });

  test('filters groups with having', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status])
      .having(expr.count(tasks.id), '>', 1)
      .orderBy([tasks.status])
      .select({ status: tasks.status })
      .all(db);

    expect(rows).toEqual([{ status: 'failed' }, { status: 'succeeded' }]);
  });

  test('ands many havings, and takes conditions', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status])
      .having(expr.count(tasks.id), '>', 1)
      .having(expr.or([expr(expr.sum(tasks.attempts), '>=', 100), expr(expr.max(tasks.scheduledTo), '<', inserted[3]!.scheduledTo)]))
      .select({ status: tasks.status })
      .all(db);

    expect(rows).toEqual([{ status: 'failed' }]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const j1 = await from(tasks)
    .groupBy([tasks.payload.kind])
    .select({ kind: tasks.payload.kind, count: expr.count(tasks.id) })
    .all(db);
  assert<Equals<typeof j1, { kind: string; count: number }[]>>();

  const j2 = await from(tasks)
    .where(tasks.status, '!=', 'scheduled')
    .groupBy([tasks.status])
    .select({ status: tasks.status, attempts: expr.sum(tasks.attempts) })
    .all(db);
  assert<Equals<typeof j2, { status: Status; attempts: number }[]>>();

  // @ts-expect-error only numeric columns can be summed
  expr.sum(tasks.status);

  // @ts-expect-error only numeric columns can be summed
  expr.sum.distinct(tasks.status);

  const j3 = await from(tasks)
    .select({
      kinds: expr.count.distinct(tasks.payload.kind),
      attempts: expr.sum.distinct(tasks.attempts),
      fewest: expr.min(tasks.attempts),
      latest: expr.max(tasks.scheduledTo),
      status: expr.max(tasks.status),
      kind: expr.min(tasks.payload.kind),
    })
    .one(db);
  assert<Equals<typeof j3, { kinds: number; attempts: number; fewest: number | null; latest: Date | null; status: Status | null; kind: string | null } | null>>();

  // @ts-expect-error JSON documents have no order to them
  expr.min(tasks.payload);

  // @ts-expect-error neither do booleans, on postgres
  expr.max(table('flags', { on: t.boolean() }).on);

  const j4 = await from(tasks).groupBy([tasks.status]).having(expr.count(tasks.id), '>', 1).select({ status: tasks.status }).all(db);
  assert<Equals<typeof j4, { status: Status }[]>>();

  // @ts-expect-error having compares like where does
  from(tasks).groupBy([tasks.status]).having(expr.count(tasks.id), '>', 'x');

  // @ts-expect-error having takes references to the query's tables only
  from(tasks).groupBy([tasks.status]).having(expr.count(users.id), '>', 1);

  // @ts-expect-error groupBy takes references to the query's table only
  from(tasks).groupBy([tasks.as('t0').status]);
};
