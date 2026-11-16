import { beforeEach, expect, test } from 'bun:test';
import { create, expr, from, into, parse, t, table } from '../src';
import { type Task, task, tasks } from './fixtures';
import { type Database, type Equals, type Expand, assert, suite } from './helpers';

const parent = tasks.as('parent');
const child = tasks.as('child');

// two parents, `a` with two children and `b` with none
const seed = async (db: Database) => {
  const [a, b] = (await into(tasks).values([task({ payload: { kind: 'a' } }), task({ payload: { kind: 'b' } })]).insert(db)) as [Task, Task];
  const children = await into(tasks).values([task({ parentId: a.id }), task({ parentId: a.id })]).insert(db);

  return { a, b, children };
};

suite('left join', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());
    ({ a, b, children } = await seed(db));
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

  test('collects the children of every parent', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ ...parent, children: expr.collect(child) })
      .all(db);

    expect(rows.map(row => ({ ...row, children: byId(row.children) }))).toEqual([
      { ...a, children: byId(children) },
      { ...b, children: [] },
    ]);
  });

  test('collects a projection of the children', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .orderBy([parent.payload.kind])
      .select({ kind: parent.payload.kind, children: expr.collect({ id: child.id, at: child.scheduledTo, kind: child.payload.kind }) })
      .all(db);

    expect(rows.map(row => ({ ...row, children: byId(row.children) }))).toEqual([
      { kind: 'a', children: byId(children.map(row => ({ id: row.id, at: row.scheduledTo, kind: 'Prune' }))) },
      { kind: 'b', children: [] },
    ]);
  });

  test('collects every row without a group by', async () => {
    const all = await from(tasks).select({ all: expr.collect(tasks) }).one(db);

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

suite('inner join', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());
    ({ a, b, children } = await seed(db));
  });

  test('leaves out rows without a match', async () => {
    const rows = await from(parent)
      .innerJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', b.id)
      .select({ id: parent.id, childId: child.id })
      .all(db);

    expect(rows).toEqual([]);
  });

  test('returns a row per match', async () => {
    const rows = await from(parent)
      .innerJoin(child, expr(parent.id, '=', child.parentId))
      .select({ id: parent.id, childId: child.id })
      .all(db);

    expect(rows.toSorted((x, y) => x.childId.localeCompare(y.childId))).toEqual(children.map(row => ({ id: a.id, childId: row.id })).toSorted((x, y) => x.childId.localeCompare(y.childId)));
  });

  test('counts the children of the parents that have any', async () => {
    const rows = await from(parent)
      .innerJoin(child, expr(parent.id, '=', child.parentId))
      .groupBy([parent.id])
      .select({ id: parent.id, children: expr.count(child.id) })
      .all(db);

    expect(rows).toEqual([{ id: a.id, children: 2 }]);
  });
});

suite('right join', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());
    ({ a, b, children } = await seed(db));
  });

  test('returns every row of the joined table', async () => {
    const count = await from(child)
      .rightJoin(parent, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .count(db);

    expect(count).toBe(3); // a twice, once per child, and b once
  });

  test('fills null in for the columns of the queried table', async () => {
    const rows = await from(child)
      .rightJoin(parent, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', b.id)
      .select({ id: parent.id, childId: child.id })
      .all(db);

    expect(rows).toEqual([{ id: b.id, childId: null }]);
  });

  test('returns rows of nulls when the queried table has no match', async () => {
    const rows = await from(child)
      .rightJoin(parent, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', b.id)
      .all(db);

    expect(rows).toEqual([Object.fromEntries(Object.keys(b).map(key => [key, null])) as (typeof rows)[number]]);
  });

  test('returns a row per match', async () => {
    const rows = await from(child)
      .rightJoin(parent, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', a.id)
      .all(db);

    expect(rows.toSorted((x, y) => x.id!.localeCompare(y.id!))).toEqual(children.toSorted((x, y) => x.id.localeCompare(y.id)));
  });
});

suite('selected tables', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());
    ({ a, b, children } = await seed(db));
  });

  const byId = <T extends { id: string }>(rows: T[]) => rows.toSorted((x, y) => x.id.localeCompare(y.id));

  test('read as an object, or null when a left join found no match', async () => {
    const rows = await from(child)
      .leftJoin(parent, expr(parent.id, '=', child.parentId))
      .select({ ...child, parent })
      .all(db);

    expect(byId(rows)).toEqual(byId([
      { ...a, parent: null },
      { ...b, parent: null },
      ...children.map(row => ({ ...row, parent: a })),
    ]));
  });

  test('read as an object after an inner join', async () => {
    const rows = await from(child)
      .innerJoin(parent, expr(parent.id, '=', child.parentId))
      .select({ id: child.id, parent })
      .all(db);

    expect(byId(rows)).toEqual(byId(children.map(row => ({ id: row.id, parent: a }))));
  });

  test('read null when a right join found no match', async () => {
    const rows = await from(child)
      .rightJoin(parent, expr(parent.id, '=', child.parentId))
      .where(parent.id, '=', b.id)
      .select({ child, parent })
      .all(db);

    expect(rows).toEqual([{ child: null, parent: b }]);
  });

  test('tell missing rows apart by every column when none is required', async () => {
    const notes = table('things', { body: t.text().optional(), kind: t.text().optional() });
    await create.table(notes).onto(db);
    await into(notes).values([{ body: 'a' }]).insert(db);

    const rows = await from(tasks)
      .leftJoin(notes, expr(notes.body, '=', tasks.payload.kind))
      .where(tasks.parentId, 'IS', null)
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, note: notes })
      .all(db);

    expect(rows).toEqual([{ kind: 'a', note: { body: 'a', kind: null } }, { kind: 'b', note: null }]);
  });

  test('are counted as distinct rows', async () => {
    const query = from(child).innerJoin(parent, expr(parent.id, '=', child.parentId)).select({ parent }).distinct();

    expect(await query.all(db)).toEqual([{ parent: a }]);
    expect(await query.count(db)).toBe(1);
  });

  test("can't share a key with another field", () => {
    expect(() => from(child).innerJoin(parent, expr(parent.id, '=', child.parentId)).select({ 'parent.id': child.id, parent }))
      .toThrow('"parent.id" is selected twice');
  });

  test('must be part of the query', () => {
    expect(() => from(child).select({ parent } as never)).toThrow('"parent.id" isn\'t part of the query');
  });
});

suite('narrowed tables', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());
    ({ a, b, children } = await seed(db));
  });

  const byId = <T extends { id: string }>(rows: T[]) => rows.toSorted((x, y) => x.id.localeCompare(y.id));

  test('read only the columns picked', async () => {
    const rows = await from(child)
      .leftJoin(parent, expr(parent.id, '=', child.parentId))
      .select({ ...child.pick(['id', 'status']), parent: parent.pick(['id', 'payload']) })
      .all(db);

    expect(byId(rows)).toEqual(byId([
      { id: a.id, status: a.status, parent: null },
      { id: b.id, status: b.status, parent: null },
      ...children.map(row => ({ id: row.id, status: row.status, parent: { id: a.id, payload: a.payload } })),
    ]));
  });

  test('read every column but those omitted', async () => {
    const rows = await from(child)
      .leftJoin(parent, expr(parent.id, '=', child.parentId))
      .where(child.parentId, 'IS NOT', null)
      .select({ ...child.omit(['parentId']), parent: parent.omit(['events']) })
      .all(db);

    const { events: _, ...rest } = a;
    expect(byId(rows)).toEqual(byId(children.map(({ parentId: _, ...row }) => ({ ...row, parent: rest }))));
  });

  test('tell missing rows apart by the primary key, even when it is left out', async () => {
    const rows = await from(child)
      .leftJoin(parent, expr(parent.id, '=', child.parentId))
      .select({ id: child.id, parent: parent.pick(['parentId']) })
      .all(db);

    expect(byId(rows)).toEqual(byId([
      { id: a.id, parent: null },
      { id: b.id, parent: null },
      ...children.map(row => ({ id: row.id, parent: { parentId: null } })),
    ]));
  });

  test('are distinct by the columns read, not by the primary key left out', async () => {
    await into(tasks).values([task({ parentId: b.id })]).insert(db);

    const query = from(child)
      .leftJoin(parent, expr(parent.id, '=', child.parentId))
      .select({ parent: parent.pick(['parentId']) })
      .distinct();

    expect(await query.all(db)).toEqual(expect.arrayContaining([{ parent: null }, { parent: { parentId: null } }]));
    expect(await query.count(db)).toBe(2);
  });

  test('are collected without the rows a left join found no match for', async () => {
    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .where(parent.parentId, 'IS', null)
      .groupBy([parent.id])
      .select({ id: parent.id, children: expr.collect(child.pick(['parentId'])) })
      .all(db);

    expect(byId(rows)).toEqual(byId([
      { id: a.id, children: children.map(() => ({ parentId: a.id })) },
      { id: b.id, children: [] },
    ]));
  });

  test('still let a query reference the columns left out', async () => {
    const rows = await from(tasks.pick(['id'])).where(tasks.parentId, '=', a.id).all(db);
    expect(byId(rows)).toEqual(byId(children.map(({ id }) => ({ id }))));
  });

  test("can't be inserted into, updated or created", async () => {
    expect(() => into(tasks.omit(['events']))).toThrow('"into" takes a whole table, "tasks" is narrowed by pick or omit');
    expect(() => parse(tasks.pick(['status']), {})).toThrow('"parse" takes a whole table');
    await expect(from(tasks.pick(['id'])).update(db, { set: { attempts: 1 } } as never)).rejects.toThrow('"update" takes a whole table');
    await expect(create.table(tasks.pick(['id'])).onto(db)).rejects.toThrow('"create.table" takes a whole table');
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  // columns of an inner-joined table keep their own nullability
  const inner = await from(parent)
    .innerJoin(child, expr(parent.id, '=', child.parentId))
    .select({ id: parent.id, childId: child.id, childParentId: child.parentId })
    .all(db);
  assert<Equals<typeof inner, { id: string; childId: string; childParentId: string | null }[]>>();

  // a right join turns the tables joined before it nullable, but not itself
  const right = await from(child)
    .rightJoin(parent, expr(parent.id, '=', child.parentId))
    .select({ id: parent.id, childId: child.id })
    .all(db);
  assert<Equals<typeof right, { id: string; childId: string | null }[]>>();

  // ...rows of the queried table included
  const whole = await from(child).rightJoin(parent, expr(parent.id, '=', child.parentId)).all(db);
  assert<Equals<typeof whole, Expand<{ [K in keyof Task]: Task[K] | null }>[]>>();

  // ...and so are left-joined tables, which an inner join leaves nullable
  const other = tasks.as('other');
  const mixed = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .innerJoin(other, expr(other.id, '=', child.parentId))
    .rightJoin(tasks, expr(tasks.id, '=', parent.parentId))
    .select({ parent: parent.id, child: child.id, other: other.id, task: tasks.id })
    .all(db);
  assert<Equals<typeof mixed, { parent: string | null; child: string | null; other: string | null; task: string }[]>>();

  // a projection reads as nullable when its table is right-joined after `select`
  const late = await from(child).select({ id: child.id }).rightJoin(parent, expr(parent.id, '=', child.parentId)).all(db);
  assert<Equals<typeof late, { id: string | null }[]>>();

  // a selected table reads as a row, or null when its row may be missing
  const belongsTo: (Task & { parent: Task | null })[] = await from(child)
    .leftJoin(parent, expr(parent.id, '=', child.parentId))
    .select({ ...child, parent })
    .all(db);
  assert<Equals<Expand<(typeof belongsTo)[number]>, Expand<Task & { parent: Task | null }>>>();

  const selectedInner = await from(child).innerJoin(parent, expr(parent.id, '=', child.parentId)).select({ parent }).all(db);
  assert<Equals<typeof selectedInner, { parent: Task }[]>>();

  const selectedRight = await from(child).rightJoin(parent, expr(parent.id, '=', child.parentId)).select({ child, parent }).all(db);
  assert<Equals<typeof selectedRight, { child: Task | null; parent: Task }[]>>();

  // @ts-expect-error a table can't be selected until it's joined
  from(child).select({ parent });

  // @ts-expect-error join conditions take references to the joined tables only
  from(parent).innerJoin(child, expr(parent.id, '=', tasks.parentId));

  // @ts-expect-error join conditions take references to the joined tables only
  from(parent).rightJoin(child, expr(parent.id, '=', tasks.parentId));

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
    .select({ ...parent, children: expr.collect(child) })
    .all(db);
  assert<Equals<Expand<(typeof k2)[number]>, Expand<Task & { children: Task[] }>>>();

  // collected rows are never missing, so their columns aren't nullable
  const projected = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .groupBy([parent.id])
    .select({ children: expr.collect({ id: child.id, kind: child.payload.kind }) })
    .all(db);
  assert<Equals<typeof projected, { children: { id: string; kind: string }[] }[]>>();

  // @ts-expect-error a table can't be collected until it's joined
  from(parent).select({ children: expr.collect(child) });

  // @ts-expect-error a table's references are out of reach until it's joined
  from(parent).where(child.id, '=', 'x');

  // @ts-expect-error join conditions must compare compatible types
  from(parent).leftJoin(child, expr(parent.id, '=', child.attempts));

  // @ts-expect-error join conditions take references to the joined tables only
  from(parent).leftJoin(child, expr(parent.id, '=', tasks.parentId));

  // a narrowed table reads as the columns it kept
  const picked = await from(child)
    .leftJoin(parent, expr(parent.id, '=', child.parentId))
    .select({ ...child.pick(['id', 'status']), parent: parent.pick(['id', 'payload']) })
    .all(db);
  assert<Equals<typeof picked, { id: string; status: Task['status']; parent: Pick<Task, 'id' | 'payload'> | null }[]>>();

  const omitted = await from(child)
    .leftJoin(parent, expr(parent.id, '=', child.parentId))
    .select({ ...child.omit(['parentId']), parent })
    .all(db);
  assert<Equals<Expand<(typeof omitted)[number]>, Expand<Omit<Task, 'parentId'> & { parent: Task | null }>>>();

  const collected = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .groupBy([parent.id])
    .select({ children: expr.collect(child.pick(['id'])) })
    .all(db);
  assert<Equals<typeof collected, { children: { id: string }[] }[]>>();

  // @ts-expect-error only the table's columns can be picked
  child.pick(['nope']);

  // @ts-expect-error a narrowed table only has the columns it kept
  child.pick(['id']).omit(['status']);
};
