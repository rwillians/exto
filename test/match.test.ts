import { beforeEach, expect, test } from 'bun:test';
import { expr, f, from, into } from '../src';
import { type Task, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('match', (fresh, adapter) => {
  let db: Database;
  let sqls: string[];
  let notify: Task;

  beforeEach(async () => {
    ({ db, sqls } = await fresh());

    [, notify] = (await into(tasks).values([
      task({ payload: { kind: 'Prune' } }),
      task({ payload: { kind: 'Notify' } }),
    ]).insert(db)) as [Task, Task];
  });

  test('filters on a regular expression', async () => {
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /^N/)).all(db)).toEqual([notify]);
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /^n/)).count(db)).toBe(0);
  });

  test('ignores case with the i flag', async () => {
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /^n/i)).all(db)).toEqual([notify]);
    expect(sqls.at(-1)).toContain(adapter.name === 'bun-postgres' ? '~* $1' : `regexp_like("tasks"."payload" ->> '$."kind"', ?, 'i')`);
  });

  test('takes flags that only change how a match is repeated', async () => {
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /^N/g)).count(db)).toBe(1);
  });

  test('is negated by expr.not', async () => {
    expect(await from(tasks).where(expr.not(expr.match(tasks.payload.kind, /^N/))).count(db)).toBe(1);
    expect(await from(tasks).where(expr.not(expr.match(tasks.payload.kind, /^n/i))).count(db)).toBe(1);
  });

  test('matches a fragment too', async () => {
    expect(await from(tasks).where(expr.match(f`lower(${tasks.payload.kind})`, /^n/)).all(db)).toEqual([notify]);
  });

  test.skipIf(adapter.name !== 'bun-postgres')('refuses flags postgres has no equivalent for', async () => {
    await expect(from(tasks).where(expr.match(tasks.payload.kind, /^N/y)).count(db)).rejects.toThrow('"y" flags of /^N/y');
    await expect(from(tasks).where(expr.match(tasks.payload.kind, /^N/ms)).count(db)).rejects.toThrow('"ms" flags of /^N/ms');
  });

  test.skipIf(adapter.name !== 'bun-sqlite')('matches the way javascript does on sqlite', async () => {
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /(?<=^N)o/)).all(db)).toEqual([notify]);
    expect(await from(tasks).where(expr.match(tasks.payload.kind, /ify$/y)).count(db)).toBe(0);
    expect(sqls.at(-2)).toContain(`"tasks"."payload" ->> '$."kind"' REGEXP ?`);
  });

  test.skipIf(adapter.name !== 'bun-sqlite')('sqlite takes REGEXP in fragments too', async () => {
    expect(await from(tasks).where(f`${tasks.payload.kind} REGEXP ${'^N'}`).all(db)).toEqual([notify]);
    expect(await from(tasks).where(f`regexp_like(${tasks.payload.kind}, ${'^n'}, ${'i'})`).all(db)).toEqual([notify]);
  });

  test('only takes text columns', () => {
    expect(() => expr.match(tasks.attempts as never, /^1/)).toThrow('"expr.match" only takes text columns, "tasks.attempts" isn\'t one');
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const rows = await from(tasks).where(expr.match(tasks.payload.kind, /^N/)).all(db);
  assert<Equals<typeof rows, Task[]>>();

  from(tasks).where(expr.or([expr.match(tasks.payload.kind, /^N/), expr(tasks.status, '=', 'queued')]));
  from(tasks).where(expr.match(f`lower(${tasks.payload.kind})`, /^n/));

  // @ts-expect-error only text matches a regular expression
  expr.match(tasks.attempts, /^1/);

  // @ts-expect-error a pattern is a regular expression, not a string
  expr.match(tasks.payload.kind, '^N');

  // @ts-expect-error the matched column must be part of the query
  from(tasks).where(expr.match(users.name, /^J/));
};
