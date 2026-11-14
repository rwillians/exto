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
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ ...parent, childCount: expr.count(child.id) })
      .all(db);

    expect(rows).toEqual([
      { ...a, childCount: 2 },
      { ...b, childCount: 0 },
    ]);
  });

  const byId = <T extends { id: string }>(rows: T[]) => rows.toSorted((x, y) => x.id.localeCompare(y.id));

  test('aggregates the children of every parent', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ ...parent, children: expr.aggregate(child) })
      .all(db);

    expect(rows.map(row => ({ ...row, children: byId(row.children) }))).toEqual([
      { ...a, children: byId(children) },
      { ...b, children: [] },
    ]);
  });

  test('aggregates a projection of the children', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ kind: parent.payload.kind, children: expr.aggregate({ id: child.id, at: child.scheduledTo, kind: child.payload.kind }) })
      .all(db);

    expect(rows.map(row => ({ ...row, children: byId(row.children) }))).toEqual([
      { kind: 'a', children: byId(children.map(row => ({ id: row.id, at: row.scheduledTo, kind: 'Prune' }))) },
      { kind: 'b', children: [] },
    ]);
  });

  test('aggregates every row without a group by', async () => {
    const all = await from(tasks).select({ all: expr.aggregate(tasks) }).one(db);

    expect(byId(all!.all)).toEqual(byId([a, b, ...children]));
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
      .where(child.id, 'IS NOT', null)
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
    .where(parent.parentId, 'IS', null)
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

  const k2 = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .where(parent.parentId, 'IS', null)
    .groupBy([parent.id])
    .select({ ...parent, children: expr.aggregate(child) })
    .all(db);
  assert<Equals<Expand<(typeof k2)[number]>, Expand<Task & { children: Task[] }>>>();

  // aggregated rows are never missing, so their columns aren't nullable
  const projected = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .groupBy([parent.id])
    .select({ children: expr.aggregate({ id: child.id, kind: child.payload.kind }) })
    .all(db);
  assert<Equals<typeof projected, { children: { id: string; kind: string }[] }[]>>();

  // @ts-expect-error a table can't be aggregated until it's joined
  from(parent).select({ children: expr.aggregate(child) });

  // @ts-expect-error a table's references are out of reach until it's joined
  from(parent).where(child.id, '=', 'x');

  // @ts-expect-error join conditions must compare compatible types
  from(parent).leftJoin(child, expr(parent.id, '=', child.attempts));

  // @ts-expect-error join conditions take references to the joined tables only
  from(parent).leftJoin(child, expr(parent.id, '=', tasks.parentId));
};
