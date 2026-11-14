import { beforeEach, describe, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type Task, task, tasks } from './fixtures';
import { type Database, type Equals, assert, fresh } from './helpers';

describe('aliased tables', () => {
  let db: Database;
  let sqls: string[];
  let rows: Task[];

  beforeEach(async () => {
    ({ db, sqls } = await fresh());

    rows = await into(tasks).values([
      task({ status: 'scheduled', attempts: 3 }),
      task({ status: 'queued' }),
    ]).insert(db);
  });

  const t0 = tasks.as('t0');

  test('are queried under their alias', async () => {
    expect(await from(t0).where(t0.status, '=', 'scheduled').all(db)).toEqual([rows[0]!]);
    expect(sqls.at(-1)).toContain('FROM "tasks" AS "t0"');
  });

  test('can be re-aliased', async () => {
    const t1 = t0.as('t1');

    expect(await from(t1).where(t1.status, '=', 'queued').all(db)).toEqual([rows[1]!]);
  });

  test('take every query method', async () => {
    expect(await from(t0).where(expr(t0.attempts, '>', 0)).orderBy([t0.createdAt]).select({ id: t0.id }).all(db)).toEqual([{ id: rows[0]!.id }]);
    expect(await from(t0).where(t0.status, '=', 'queued').count(db)).toBe(1);
    expect(await from(t0).where(t0.status, '=', 'queued').update(db, { inc: { attempts: 1 }, returning: ['attempts'] })).toEqual([{ attempts: 1 }]);
    expect(await from(t0).where(t0.status, '=', 'queued').delete(db, { returning: ['id'] })).toEqual([{ id: rows[1]!.id }]);
  });

  test('compare columns of the same row', async () => {
    expect(await from(tasks).where(tasks.attempts, '=', tasks.maxAttempts).all(db)).toEqual([rows[0]!]);
    expect(await from(t0).where(t0.attempts, '=', t0.maxAttempts).all(db)).toEqual([rows[0]!]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const t0 = tasks.as('t0');
  const t1 = tasks.as('t1');

  const h1 = await from(t0).where(t0.status, '=', 'scheduled').all(db);
  assert<Equals<typeof h1, Task[]>>();

  const h2 = await from(tasks).where(tasks.attempts, '=', tasks.maxAttempts).all(db);
  assert<Equals<typeof h2, Task[]>>();

  const picked = await from(t0).select({ id: t0.id }).one(db);
  assert<Equals<typeof picked, { id: string } | null>>();

  // @ts-expect-error references must be to the query's alias
  from(t0).where(t1.status, '=', 'queued');

  // @ts-expect-error unaliased queries don't take references to an alias
  from(tasks).where(t0.status, '=', 'queued');

  // @ts-expect-error aliased queries don't take references to the unaliased table
  from(t0).where(tasks.status, '=', 'queued');

  // @ts-expect-error compared columns must be to the query's alias
  from(t0).where(t0.status, '=', t1.status);

  // @ts-expect-error projections take references to the query's alias only
  from(t0).select({ id: t1.id });

  // @ts-expect-error orderBy takes references to the query's alias only
  from(t0).orderBy([t1.createdAt]);
};
