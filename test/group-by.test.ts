import { beforeEach, describe, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type Status, task, tasks } from './fixtures';
import { type Database, type Equals, assert, fresh } from './helpers';

describe('group by', () => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());

    await into(tasks).values([
      task({ status: 'scheduled', payload: { kind: 'Prune' } }),
      task({ status: 'failed', payload: { kind: 'Prune' }, attempts: 3 }),
      task({ status: 'failed', payload: { kind: 'Notify' }, attempts: 2 }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1 }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1 }),
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

  // @ts-expect-error groupBy takes references to the query's table only
  from(tasks).groupBy([tasks.as('t0').status]);
};
