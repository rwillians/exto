import { beforeEach, expect, test } from 'bun:test';
import { expr, from, into } from '../src';
import { type User, jane, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('coalesce', (fresh) => {
  let db: Database;
  let janeRow: User;
  let johnRow: User;

  const epoch = new Date(0);

  beforeEach(async () => {
    ({ db } = await fresh());

    [janeRow, johnRow] = (await into(users).values([
      jane,
      { name: 'John Doe', email: 'john.doe@example.com', lastLoggedInAt: minutesAgo(1) },
    ]).insert(db)) as [User, User];
  });

  test('reads the first operand that is not null', async () => {
    const rows = await from(users)
      .orderBy([users.name])
      .select({ name: users.name, seen: expr.coalesce(users.lastLoggedInAt, users.createdAt) })
      .all(db);

    expect(rows).toEqual([
      { name: 'Jane Doe', seen: janeRow.createdAt },
      { name: 'John Doe', seen: johnRow.lastLoggedInAt! },
    ]);
  });

  test('falls back to a plain value', async () => {
    const rows = await from(users)
      .orderBy([users.name])
      .select({ seen: expr.coalesce(users.lastLoggedInAt, epoch) })
      .all(db);

    expect(rows).toEqual([{ seen: epoch }, { seen: johnRow.lastLoggedInAt! }]);
  });

  test('compares like its first operand', async () => {
    const rows = await from(users).where(expr.coalesce(users.lastLoggedInAt, epoch), '=', epoch).select({ id: users.id }).all(db);

    expect(rows).toEqual([{ id: janeRow.id }]);
  });

  test('fills in for the columns of unmatched rows', async () => {
    const parent = tasks.as('parent');
    const child = tasks.as('child');

    await into(tasks).values(task({ payload: { kind: 'lonely' } })).insert(db);

    const rows = await from(parent)
      .leftJoin(child, expr(parent.id, '=', child.parentId))
      .select({ kind: expr.coalesce(child.payload.kind, 'none'), attempts: expr.coalesce(child.attempts, -1) })
      .all(db);

    expect(rows).toEqual([{ kind: 'none', attempts: -1 }]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const parent = tasks.as('parent');
  const child = tasks.as('child');

  // null only when every operand may be
  const c1 = await from(users)
    .select({
      columns: expr.coalesce(users.lastLoggedInAt, users.createdAt),
      value: expr.coalesce(users.lastLoggedInAt, new Date(0)),
      nullable: expr.coalesce(users.lastLoggedInAt, users.lastLoggedInAt),
    })
    .all(db);
  assert<Equals<typeof c1, { columns: Date; value: Date; nullable: Date | null }[]>>();

  // a left-joined column may read null, unless a value or a column of the
  // queried table stands in for it
  const c2 = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .select({
      value: expr.coalesce(child.payload.kind, 'none'),
      column: expr.coalesce(child.id, parent.id),
      joined: expr.coalesce(child.id, child.parentId),
    })
    .all(db);
  assert<Equals<typeof c2, { value: string; column: string; joined: string | null }[]>>();

  // ...or the join keeps its rows
  const c3 = await from(parent)
    .innerJoin(child, expr(parent.id, '=', child.parentId))
    .select({ joined: expr.coalesce(child.id, child.parentId) })
    .all(db);
  assert<Equals<typeof c3, { joined: string }[]>>();

  // it reads null only when the rows of every table it reads from may be missing
  const other = tasks.as('other');
  const c4 = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .leftJoin(other, expr(other.id, '=', parent.parentId))
    .select({ id: expr.coalesce(child.id, other.id) })
    .all(db);
  assert<Equals<typeof c4, { id: string | null }[]>>();

  const c5 = await from(parent)
    .leftJoin(child, expr(parent.id, '=', child.parentId))
    .innerJoin(other, expr(other.id, '=', parent.parentId))
    .select({ id: expr.coalesce(child.id, other.id) })
    .all(db);
  assert<Equals<typeof c5, { id: string }[]>>();

  // @ts-expect-error every operand has to read the same type
  expr.coalesce(users.lastLoggedInAt, 'never');

  // @ts-expect-error every operand has to read the same type
  expr.coalesce(users.lastLoggedInAt, users.name);

  // @ts-expect-error coalesce takes references to the query's tables only
  from(users).select({ id: expr.coalesce(tasks.parentId, tasks.id) });
};
