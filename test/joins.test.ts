import { beforeEach, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type Task, task, tasks } from './fixtures';
import { type Database, type Equals, type Expand, assert, suite } from './helpers';

suite('left join', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  const parent = tasks.as('parent');
  const child = tasks.as('child');

  beforeEach(async () => {
    ({ db } = await fresh());

    [a, b] = (await into(tasks).values([task({ payload: { kind: 'a' } }), task({ payload: { kind: 'b' } })]).insert(db)) as [Task, Task];
    children = await into(tasks).values([task({ parentId: a.id }), task({ parentId: a.id })]).insert(db);
  });

  test('counts the children of every parent', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'is', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ ...parent, childCount: expr.count(child.id) })
      .all(db);

    expect(rows).toEqual([
      { ...a, childCount: 2 },
      { ...b, childCount: 0 },
    ]);
  });

  test('fills null in for the columns of unmatched rows', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', b.id)
      .select({ id: parent.id, childId: child.id })
      .all(db);

    expect(rows).toEqual([{ id: b.id, childId: null }]);
  });

  test('returns a row per match', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', a.id)
      .select({ childId: child.id })
      .all(db);

    expect(rows.map(row => row.childId).sort()).toEqual(children.map(row => row.id).sort());
  });

  test('takes filters on the joined table', async () => {
    const count = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(child.id, 'is not', null)
      .count(db);

    expect(count).toBe(2);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const parent = tasks.as('parent');
  const child = tasks.as('child');

  const k1 = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .where(parent.parentId, 'is', null)
    .groupBy([parent.id])
    .select({ ...parent, childCount: expr.count(child.id) })
    .all(db);
  assert<Equals<Expand<(typeof k1)[number]>, Expand<Task & { childCount: number }>>>();

  // columns of a left-joined table are nullable
  const nullable = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .select({ id: parent.id, childId: child.id, childStatus: child.status })
    .all(db);
  assert<Equals<typeof nullable, { id: string; childId: string | null; childStatus: Task['status'] | null }[]>>();

  // without a projection, a join still returns the rows of the queried table
  const rows = await from(parent).leftJoin(child, expr(parent.id, '=', child.parentId)).all(db);
  assert<Equals<typeof rows, Task[]>>();

  // @ts-expect-error a table's references are out of reach until it's joined
  from(parent).where(child.id, '=', 'x');

  // @ts-expect-error join conditions must compare compatible types
  from(parent).leftJoin(child, expr(parent.id, '=', child.attempts));

  // @ts-expect-error join conditions take references to the joined tables only
  from(parent).leftJoin(child, expr(parent.id, '=', tasks.parentId));
};
