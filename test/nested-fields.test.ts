import { beforeEach, expect, test } from 'bun:test';
import { expr, f, from, into } from '../src';
import { type Task, task, tasks } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('nested fields', (fresh, adapter) => {
  let db: Database;
  let prune: Task;

  beforeEach(async () => {
    ({ db } = await fresh());

    [prune] = (await into(tasks).values([
      task({ payload: { kind: 'Prune', params: { days: 30 } } }),
      task({ payload: { kind: 'Notify' } }),
    ]).insert(db)) as [Task, Task];
  });

  test('can be filtered on through a reference', async () => {
    expect(await from(tasks).where(tasks.payload.kind, '=', 'Prune').all(db)).toEqual([prune]);
  });

  test('can be filtered on through a fragment', async () => {
    expect(await from(tasks).where(f`${tasks.payload}->>'kind'`, '=', 'Prune').all(db)).toEqual([prune]);
  });

  test('a fragment takes a nested reference too', async () => {
    expect(await from(tasks).where(f`upper(${tasks.payload.kind})`, '=', 'PRUNE').all(db)).toEqual([prune]);
  });

  test('a fragment can be a condition of its own', async () => {
    const notify = await from(tasks).where(f`length(${tasks.payload.kind}) > ${5}`).select({ kind: tasks.payload.kind }).all(db);
    const both = await from(tasks).where(expr.or([f`length(${tasks.payload.kind}) > ${5}`, expr(tasks.payload.kind, '=', 'Prune')])).count(db);

    expect(notify).toEqual([{ kind: 'Notify' }]);
    expect(both).toBe(2);
  });

  test.skipIf(adapter.name !== 'bun-postgres')('a fragment can use operators exto has no name for', async () => {
    expect(await from(tasks).where(f`${tasks.payload} @> ${{ kind: 'Prune' }}`).all(db)).toEqual([prune]);
    expect(await from(tasks).where(f`${tasks.payload.kind} ~ ${'^N'}`).count(db)).toBe(1);
  });

  test('can be selected', async () => {
    const rows = await from(tasks).where(tasks.payload.kind, '=', 'Prune').select({ kind: tasks.payload.kind, params: tasks.payload.params }).all(db);

    expect(rows).toEqual([{ kind: 'Prune', params: { days: 30 } }]);
  });

  test('can be ordered by', async () => {
    const rows = await from(tasks).orderBy([tasks.payload.kind]).select({ kind: tasks.payload.kind }).all(db);

    expect(rows).toEqual([{ kind: 'Notify' }, { kind: 'Prune' }]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const i1 = await from(tasks).where(tasks.payload.kind, '=', 'Prune').all(db);
  assert<Equals<typeof i1, Task[]>>();

  const i2 = await from(tasks).where(f`${tasks.payload}->>'kind'`, '=', 'Prune').all(db);
  assert<Equals<typeof i2, Task[]>>();

  const conditioned = await from(tasks).where(f`${tasks.payload} @> ${{ kind: 'Prune' }}`).all(db);
  assert<Equals<typeof conditioned, Task[]>>();

  from(tasks).where(expr.and([f`${tasks.payload.kind} ~ ${'^N'}`, expr(tasks.status, '=', 'queued')]));

  // @ts-expect-error a column isn't a condition, unless it's a fragment
  from(tasks).where(tasks.status);

  // @ts-expect-error neither is an aggregate
  from(tasks).where(expr.count(tasks.id));

  // @ts-expect-error fragments' references must be to the query's table
  from(tasks).where(f`${tasks.as('t0').status} ~ ${'^N'}`);

  // @ts-expect-error nested values must match the field type
  from(tasks).where(tasks.payload.kind, '=', 1);

  // @ts-expect-error unknown nested fields don't exist
  tasks.payload.nope;
};
