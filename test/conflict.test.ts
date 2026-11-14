import { beforeEach, expect, test } from 'bun:test';
import { from, into } from '../src';
import { type User, jane, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('insert on conflict', (fresh) => {
  let db: Database;
  let existing: User;

  beforeEach(async () => {
    ({ db } = await fresh());
    [existing] = (await into(users).values({ ...jane, logins: 1 }).insert(db)) as [User];
  });

  test('throws by default', async () => {
    await expect(into(users).values({ ...jane, name: 'Jane Doe 5' }).insert(db)).rejects.toThrow();
    expect(await from(users).all(db)).toEqual([existing]);
  });

  test('throws given do: "throw"', async () => {
    const insert = into(users)
      .values({ ...jane, name: 'Jane Doe 4' })
      .insert(db, { conflict: { on: ['email'], do: 'throw' } });

    await expect(insert).rejects.toThrow();
    expect(await from(users).all(db)).toEqual([existing]);
  });

  test('skips conflicting rows given do: "nothing"', async () => {
    const inserted = await into(users)
      .values({ ...jane, name: 'Jane Doe 1' })
      .values({ name: 'John Doe', email: 'john.doe@example.com' })
      .insert(db, { conflict: { on: ['email'], do: 'nothing' } });

    expect(inserted.map(user => user.name)).toEqual(['John Doe']);
    expect(await from(users).where(users.email, '=', jane.email).one(db)).toEqual(existing);
  });

  test('sets and increments columns of the existing row', async () => {
    const [updated] = await into(users)
      .values({ ...jane, name: 'Jane Doe 2' })
      .insert(db, {
        conflict: {
          on: ['email'],
          do: { set: { name: 'Jane Doe 2' }, inc: { logins: 1 } },
        },
      });

    expect(updated).toEqual({ ...existing, name: 'Jane Doe 2', logins: 2 });
    expect(await from(users).all(db)).toEqual([updated!]);
  });

  test('replaces columns of the existing row with the inserted ones', async () => {
    const lastLoggedInAt = new Date('2026-11-14T00:00:00.000Z');
    const [updated] = await into(users)
      .values({ ...jane, name: 'Jane Doe 3', lastLoggedInAt })
      .insert(db, {
        conflict: {
          on: ['email'],
          do: { replace: ['name', 'lastLoggedInAt'], inc: { logins: 1 } },
        },
      });

    expect(updated).toEqual({ ...existing, name: 'Jane Doe 3', lastLoggedInAt, logins: 2 });
  });

  test('inserts rows that conflict with nothing', async () => {
    const inserted = await into(users)
      .values({ name: 'John Doe', email: 'john.doe@example.com' })
      .insert(db, { conflict: { on: ['email'], do: { set: { name: 'nope' } } } });

    expect(inserted).toMatchObject([{ name: 'John Doe', logins: 0 }]);
    expect(await from(users).count(db)).toBe(2);
  });

  test('returns the given columns', async () => {
    const inserted = await into(users)
      .values(jane)
      .insert(db, { conflict: { on: ['email'], do: { inc: { logins: 1 } } }, returning: ['logins'] });

    expect(inserted).toEqual([{ logins: 2 }]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const b1 = await into(users).values(jane).insert(db, { conflict: { on: ['email'], do: 'nothing' } });
  assert<Equals<typeof b1, User[]>>();

  const b2 = await into(users).values(jane).insert(db, { conflict: { on: ['email'], do: { set: { name: 'x' }, inc: { logins: 1 } } } });
  assert<Equals<typeof b2, User[]>>();

  const b3 = await into(users).values(jane).insert(db, { conflict: { on: ['email'], do: { replace: ['name'], inc: { logins: 1 } } } });
  assert<Equals<typeof b3, User[]>>();

  const b4 = await into(users).values(jane).insert(db, { conflict: { on: ['email'], do: 'throw' } });
  assert<Equals<typeof b4, User[]>>();

  const ids = await into(users).values(jane).insert(db, { conflict: { on: ['email'], do: 'nothing' }, returning: ['id'] });
  assert<Equals<typeof ids, Pick<User, 'id'>[]>>();

  // @ts-expect-error conflict targets are the table's keys
  into(users).values(jane).insert(db, { conflict: { on: ['nope'], do: 'nothing' } });

  // @ts-expect-error conflict targets are keys, not column names
  into(users).values(jane).insert(db, { conflict: { on: ['last_logged_in_at'], do: 'nothing' } });

  // @ts-expect-error only numeric columns can be incremented
  into(users).values(jane).insert(db, { conflict: { on: ['email'], do: { inc: { name: 1 } } } });

  // @ts-expect-error set values must match the column type
  into(users).values(jane).insert(db, { conflict: { on: ['email'], do: { set: { name: 1 } } } });

  // @ts-expect-error primary keys can't be replaced
  into(users).values(jane).insert(db, { conflict: { on: ['email'], do: { replace: ['id'] } } });

  // @ts-expect-error unknown conflict actions are rejected
  into(users).values(jane).insert(db, { conflict: { on: ['email'], do: 'update' } });
};
