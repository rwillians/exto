import { beforeEach, describe, expect, test } from 'bun:test';
import { ValidationError, expr, from, into, type IDatabase } from '../src';
import * as pg from '../src/bun-postgres';
import * as sqlite from '../src/bun-sqlite';
import { migrate, tasks, things } from './fixtures';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// postgres tests only run when a database is available, e.g.:
// docker run --rm -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:18-alpine
// EXTO_PG_URL=postgres://postgres:pg@localhost:55432/postgres bun test
const PG_URL = process.env['EXTO_PG_URL'];

type Logger = { debug: (sql: string) => void, error: () => void };

// one connection pool per suite, so postgres doesn't run out of clients
let pgdb: IDatabase | undefined;

const adapters: { name: string, skip: boolean, fresh: (logger: Logger) => Promise<IDatabase> }[] = [
  {
    name: 'bun-sqlite',
    skip: false,
    fresh: async (logger) => sqlite.connect(':memory:', { loggers: [logger] }),
  },
  {
    name: 'bun-postgres',
    skip: PG_URL === undefined,
    fresh: async (logger) => {
      pgdb ??= pg.connect(PG_URL!, { loggers: [logger] });
      await pgdb.execute('DROP TABLE IF EXISTS tasks, things, schema_migrations', []);
      return pgdb;
    },
  },
];

for (const adapter of adapters) {
  describe.skipIf(adapter.skip)(adapter.name, () => {
    let db: IDatabase;
    let sqls: string[] = [];

    const insertTasks = () => into(tasks)
      .values({ status: 'scheduled', type: 'Prune', payload: { n: 1 }, scheduledAt: new Date(Date.now() - 1000) })
      .values([
        { status: 'scheduled', type: 'Prune', payload: {}, scheduledAt: new Date(Date.now() - 500) },
        { status: 'queued', type: 'Other', payload: {}, scheduledAt: '2099-01-01T00:00:00Z', attempts: 5 },
      ])
      .insert(db);

    beforeEach(async () => {
      // the logger reads `sqls` at call time, so it follows the reassignment
      db = await adapter.fresh({ debug: (sql) => sqls.push(sql), error: () => {} });
      sqls = [];
      await migrate(db);
    });

    describe('migrations', () => {
      test('are applied once', async () => {
        await migrate(db);
        expect(await from(tasks).select(db)).toEqual([]);
        expect(sqls.filter(sql => sql.startsWith('CREATE TABLE "tasks"'))).toHaveLength(1);
      });

      test('create unique indexes', async () => {
        const row = { day: '2026-11-13', amount: 1, ratio: 1, big: 1, doc: { a: [] } };
        await into(things).values({ ...row, body: 'a' }).insert(db);

        expect(sqls).toContain('CREATE UNIQUE INDEX "things_day_big_index" ON "things" ("day", "big")');
        await expect(into(things).values({ ...row, body: 'b' }).insert(db)).rejects.toThrow();
        expect(await into(things).values({ ...row, big: 2, body: 'b' }).insert(db)).toHaveLength(1);
      });
    });

    describe('insert', () => {
      test('fills defaults and nullable columns', async () => {
        const [first, , third] = await insertTasks();

        expect(first!.parentId).toBeNull();
        expect(first!.attempts).toBe(0);
        expect(first!.createdAt).toBeInstanceOf(Date);
        expect(first!.payload).toEqual({ n: 1 });
        expect(third!.attempts).toBe(5);
        expect(third!.scheduledAt).toEqual(new Date('2099-01-01T00:00:00Z'));
      });

      test('generates uuid v7 ids client-side', async () => {
        const before = Date.now();
        const inserted = await insertTasks();
        const after = Date.now();

        expect(new Set(inserted.map(task => task.id)).size).toBe(3);

        for (const { id } of inserted) {
          expect(id).toMatch(UUID_V7);
          const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
          expect(ms).toBeGreaterThanOrEqual(before);
          expect(ms).toBeLessThanOrEqual(after);
        }

        expect(sqls.find(sql => sql.startsWith('INSERT INTO "tasks"'))).toContain('("id", ');
      });

      test('returns every field given returning: true', async () => {
        const row = { status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() } as const;
        const [byDefault] = await into(tasks).values(row).insert(db);
        const [explicitly] = await into(tasks).values(row).insert(db, { returning: true });

        expect(Object.keys(explicitly!)).toEqual(Object.keys(byDefault!));
      });

      test('returns only the requested fields', async () => {
        const inserted = await into(tasks)
          .values({ status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() })
          .insert(db, { returning: ['id', 'scheduledAt'] });

        expect(inserted).toEqual([{ id: expect.stringMatching(UUID_V7), scheduledAt: expect.any(Date) }]);
        expect(sqls.find(sql => sql.startsWith('INSERT INTO "tasks"'))).toEndWith(' RETURNING "id" AS "id", "scheduled_at" AS "scheduledAt"');
      });

      test('returns nothing given returning: false', async () => {
        const inserted = await into(tasks)
          .values({ status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() })
          .insert(db, { returning: false });

        expect(inserted).toBeUndefined();
        expect(sqls.find(sql => sql.startsWith('INSERT INTO "tasks"'))).not.toContain('RETURNING');
        expect(await from(tasks).select(db, ['type'])).toEqual([{ type: 'x' }]);
      });

      test('returns an empty object per row given returning: []', async () => {
        const inserted = await into(tasks)
          .values([
            { status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() },
            { status: 'queued', type: 'y', payload: {}, scheduledAt: new Date() },
          ])
          .insert(db, { returning: [] });

        expect(inserted).toEqual([{}, {}]);
        expect(sqls.find(sql => sql.startsWith('INSERT INTO "tasks"'))).toEndWith(' RETURNING 1');
        expect(await from(tasks).orderBy(['type']).select(db, ['type'])).toEqual([{ type: 'x' }, { type: 'y' }]);
      });

      test('rejects invalid rows', async () => {
        const row = { status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() } as const;

        const issuesOf = (values: any) => into(tasks).values(values).insert(db).then(
          () => { throw new Error('expected a ValidationError'); },
          (error) => { expect(error).toBeInstanceOf(ValidationError); return (error as ValidationError).issues; },
        );

        expect(await issuesOf([row, { ...row, status: 'nope' }])).toEqual([{ path: [1, 'status'], message: expect.stringContaining('must be one of') }]);
        expect(await issuesOf({ ...row, extra: 1 })).toEqual([{ path: [0, 'extra'], message: 'unknown field' }]);
        expect(await issuesOf({ ...row, type: 'x'.repeat(49) })).toEqual([{ path: [0, 'type'], message: 'must be at most 48 characters long' }]);
        expect(await issuesOf({ status: 'queued', payload: {}, scheduledAt: new Date() })).toEqual([{ path: [0, 'type'], message: 'is required' }]);
        expect(await from(tasks).select(db)).toEqual([]);
      });

      test('validates json columns with third-party standard schemas', async () => {
        const row = { day: '2026-11-12', amount: 1, ratio: 1, big: 1, body: 'hi' };

        // `doc` is a zod schema
        await expect(into(things).values({ ...row, doc: { a: ['nope'] } } as any).insert(db)).rejects.toBeInstanceOf(ValidationError);
        expect(await into(things).values({ ...row, doc: { a: [1] } }).insert(db)).toHaveLength(1);
      });

      test('round-trips every primitive', async () => {
        const row = { blob: new Uint8Array([1, 2, 255]), day: '2026-11-12', amount: 12.5, ratio: -0.25, big: 2 ** 40, doc: { a: [1, 2] }, body: 'hi' };
        const [thing] = await into(things).values(row).insert(db);

        expect(thing).toEqual({ seq: 1, flag: false, list: ['x', 1], ...row, blob: expect.any(Uint8Array) });
        expect([...thing!.blob!]).toEqual([1, 2, 255]);

        const [again] = await from(things)
          .where('flag', '=', false)
          .where('day', '=', '2026-11-12')
          .where('big', '>', 2 ** 39)
          .select(db);

        expect(again).toEqual(thing);
      });
    });

    describe('insert on conflict', () => {
      const row = { day: '2026-11-13', amount: 1, ratio: 1, big: 1, doc: { a: [] }, body: 'a' };
      const other = { ...row, big: 2, body: 'c' };

      test('does nothing', async () => {
        await into(things).values(row).insert(db);
        const inserted = await into(things)
          .values([{ ...row, body: 'b' }, other])
          .insert(db, { conflict: { on: ['day', 'big'], do: 'nothing' }, returning: ['body'] });

        expect(sqls.at(-1)).toContain(' ON CONFLICT ("day", "big") DO NOTHING RETURNING ');
        expect(inserted).toEqual([{ body: 'c' }]);
        expect(await from(things).orderBy(['big']).select(db, ['body'])).toEqual([{ body: 'a' }, { body: 'c' }]);
      });

      test('throws', async () => {
        await into(things).values(row).insert(db);

        await expect(into(things).values({ ...row, body: 'b' }).insert(db, { conflict: { on: ['day', 'big'], do: 'throw' } })).rejects.toThrow();
        expect(sqls.at(-1)).not.toContain('ON CONFLICT');
        expect(await from(things).select(db, ['body'])).toEqual([{ body: 'a' }]);
      });

      test('does nothing on any conflict', async () => {
        await into(things).values(row).insert(db);

        expect(await into(things).values({ ...row, big: 3 }).insert(db, { conflict: { on: [], do: 'nothing' }, returning: [] })).toEqual([]);
        expect(sqls.at(-1)).toContain(' ON CONFLICT DO NOTHING RETURNING 1');
      });

      test('sets and increments', async () => {
        await into(things).values(row).insert(db);
        const upserted = await into(things)
          .values([{ ...row, body: 'b' }, other])
          .insert(db, { conflict: { on: ['day', 'big'], do: { set: { flag: true }, inc: { amount: 0.5 } } } });

        expect(sqls.at(-1)).toContain(` DO UPDATE SET "flag" = ${db.dialect.placeholder(19)}, "amount" = "things"."amount" + ${db.dialect.placeholder(20)} RETURNING `);
        expect(upserted.map(thing => [thing.big, thing.body, thing.flag, thing.amount]).sort()).toEqual([[1, 'a', true, 1.5], [2, 'c', false, 1]]);
      });

      test('replaces with the values being inserted', async () => {
        await into(things).values(row).insert(db);
        const [upserted] = await into(things)
          .values({ ...row, ratio: 2, body: 'b' })
          .insert(db, { conflict: { on: ['day', 'big'], do: { replace: ['ratio', 'body'], inc: { amount: 1 } } } });

        expect(sqls.at(-1)).toContain(' DO UPDATE SET "amount" = "things"."amount" + ');
        expect(sqls.at(-1)).toContain(', "ratio" = EXCLUDED."ratio", "body" = EXCLUDED."body" RETURNING ');
        expect([upserted!.ratio, upserted!.body, upserted!.amount]).toEqual([2, 'b', 2]);
      });

      test('rejects empty and invalid changes', async () => {
        const upsert = (changes: any) => into(things).values(row).insert(db, { conflict: { on: ['day', 'big'], do: changes } });

        await expect(upsert({})).rejects.toThrow('Nothing to update on conflict');
        await expect(upsert({ replace: ['seq'] })).rejects.toThrow('Cannot replace "seq"');
        await expect(upsert({ set: { flag: 'yes' } })).rejects.toBeInstanceOf(ValidationError);
      });
    });

    describe('select', () => {
      test('filters and orders', async () => {
        const [first, second] = await insertTasks();
        const due = await from(tasks).where('scheduledAt', '<', new Date()).orderBy([['scheduledAt', 'DESC']]).select(db);

        expect(due.map(task => task.id)).toEqual([second!.id, first!.id]);
      });

      test('limits and offsets', async () => {
        const [, , third] = await insertTasks();

        expect(await from(tasks).where('scheduledAt', '<', new Date()).limit(1).offset(0).select(db)).toHaveLength(1);
        expect(await from(tasks).orderBy(['scheduledAt']).offset(2).select(db, ['id'])).toEqual([{ id: third!.id }]);
      });

      test('picks columns', async () => {
        await insertTasks();
        const rows = await from(tasks.as('t')).where('type', 'like', 'Pru%').select(db, ['id', 'type']);

        expect(rows).toHaveLength(2);
        expect(Object.keys(rows[0]!)).toEqual(['id', 'type']);
      });

      test('returns an empty object per row given no columns', async () => {
        await insertTasks();

        expect(await from(tasks.as('t')).where('type', '=', 'Prune').select(db, [])).toEqual([{}, {}]);
        expect(sqls.at(-1)).toStartWith('SELECT 1 FROM "tasks" AS "t"');
      });

      test('checks whether any row matches', async () => {
        await insertTasks();

        expect(await from(tasks).where('status', '=', 'queued').exists(db)).toBe(true);
        expect(sqls.at(-1)).toBe(`SELECT 1 FROM "tasks" AS "tasks" WHERE "tasks"."status" = ${db.dialect.placeholder(1)} LIMIT ${db.dialect.placeholder(2)}`);
        expect(await from(tasks).where('status', '=', 'failed').exists(db)).toBe(false);
        expect(await from(tasks).offset(2).exists(db)).toBe(true);
        expect(await from(tasks).offset(3).exists(db)).toBe(false);
        expect(await from(tasks).limit(0).exists(db)).toBe(false);
      });

      test('supports in, not in and is null', async () => {
        await insertTasks();

        expect(await from(tasks).where('status', 'in', []).select(db)).toHaveLength(0);
        expect(await from(tasks).where('status', 'not in', []).select(db)).toHaveLength(3);
        expect(await from(tasks).where('status', 'not in', ['queued']).where('parentId', 'is', null).select(db)).toHaveLength(2);
        expect(await from(tasks).where('parentId', 'is not', null).select(db)).toHaveLength(0);
      });

      test('supports or and and groups', async () => {
        const [first, second, third] = await insertTasks();
        const p = (n: number) => db.dialect.placeholder(n);

        const anyOf = await from(tasks)
          .where(expr.or([expr('status', '=', 'queued'), expr('scheduledAt', '<', new Date())]))
          .select(db, ['id']);

        expect(anyOf.map(task => task.id).sort()).toEqual([first!.id, second!.id, third!.id].sort());

        const nested = await from(tasks)
          .where('type', '=', 'Prune')
          .where(expr.or([
            expr.and([expr('status', '=', 'scheduled'), expr('attempts', '=', 0)]),
            expr('status', '=', 'queued'),
          ]))
          .select(db, ['id']);

        expect(sqls.at(-1)).toEndWith(` WHERE "tasks"."type" = ${p(1)} AND (("tasks"."status" = ${p(2)} AND "tasks"."attempts" = ${p(3)}) OR "tasks"."status" = ${p(4)})`);
        expect(nested.map(task => task.id).sort()).toEqual([first!.id, second!.id].sort());
      });

      test('counts the rows select would return', async () => {
        expect(await from(tasks).count(db)).toBe(0);

        await insertTasks();

        expect(await from(tasks).count(db)).toBe(3);
        expect(sqls.at(-1)).toBe('SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "tasks" AS "tasks") AS "q"');
        expect(await from(tasks).where('type', '=', 'Prune').count(db)).toBe(2);
        expect(await from(tasks).where(expr.or([expr('status', '=', 'queued'), expr('attempts', '>', 0)])).count(db)).toBe(1);
        expect(await from(tasks).orderBy(['scheduledAt']).limit(2).count(db)).toBe(2);
        expect(await from(tasks).orderBy(['scheduledAt']).offset(2).count(db)).toBe(1);
      });

      test('treats empty groups like empty in lists', async () => {
        await insertTasks();

        expect(await from(tasks).where(expr.or([])).select(db)).toHaveLength(0);
        expect(await from(tasks).where(expr.and([])).select(db)).toHaveLength(3);
      });

      test('rejects unknown keys in expressions', () => {
        expect(() => from(tasks).where(expr.or([expr('nope' as any, '=', 1)]))).toThrow();
      });
    });

    describe('update', () => {
      test('sets and increments, returning the updated rows', async () => {
        await insertTasks();
        const updated = await from(tasks).where('scheduledAt', '<', new Date()).update(db, { set: { status: 'running' }, inc: { attempts: 1 } });

        expect(updated.map(task => [task.status, task.attempts])).toEqual([['running', 1], ['running', 1]]);
      });

      test('increments decimals and floats', async () => {
        await into(things).values({ day: '2026-11-12', amount: 12.5, ratio: -0.25, big: 1, doc: { a: [] }, body: 'hi' }).insert(db);
        const [thing] = await from(things).update(db, { inc: { amount: 0.25, ratio: 1 }, set: { flag: true } });

        expect([thing!.amount, thing!.ratio, thing!.flag]).toEqual([12.75, 0.75, true]);
      });

      test('returns only the requested fields', async () => {
        await insertTasks();
        const scheduled = from(tasks).where('status', '=', 'scheduled');

        expect(await scheduled.update(db, { set: { type: 'w' }, returning: true })).toEqual([expect.objectContaining({ type: 'w' }), expect.objectContaining({ type: 'w' })]);
        expect(await scheduled.update(db, { set: { type: 'x' }, returning: ['type'] })).toEqual([{ type: 'x' }, { type: 'x' }]);
        expect(await scheduled.update(db, { set: { type: 'y' }, returning: [] })).toEqual([{}, {}]);
        expect(sqls.at(-1)).toEndWith(' RETURNING 1');
        expect(await scheduled.update(db, { set: { type: 'z' }, returning: false })).toBeUndefined();
        expect(sqls.at(-1)).not.toContain('RETURNING');
        expect(await scheduled.select(db, ['type'])).toEqual([{ type: 'z' }, { type: 'z' }]);
      });

      test('filters with expressions', async () => {
        await insertTasks();
        const updated = await from(tasks)
          .where(expr.or([expr('status', '=', 'queued'), expr('attempts', '>', 0)]))
          .update(db, { inc: { attempts: 1 }, returning: ['attempts'] });

        expect(updated).toEqual([{ attempts: 6 }]);
        expect(await from(tasks).where(expr.or([expr('type', '=', 'Other'), expr('parentId', 'is not', null)])).delete(db, { returning: ['type'] })).toEqual([{ type: 'Other' }]);
      });

      test('rejects empty changes and bounded queries', async () => {
        await expect(from(tasks).update(db, {})).rejects.toThrow('Nothing to update');
        await expect(from(tasks).update(db, { returning: [] })).rejects.toThrow('Nothing to update');
        await expect(from(tasks).limit(1).update(db, { set: { status: 'running' } })).rejects.toThrow('Cannot update');
      });
    });

    describe('delete', () => {
      test('returns nothing by default', async () => {
        await insertTasks();

        expect(await from(tasks.as('t')).where('status', '=', 'scheduled').delete(db)).toBeUndefined();
        expect(sqls.at(-1)).not.toContain('RETURNING');
        expect(await from(tasks).select(db)).toHaveLength(1);
      });

      test('returns the deleted rows given returning: true', async () => {
        const [first, second] = await insertTasks();
        const deleted = await from(tasks.as('t')).where('status', '=', 'scheduled').delete(db, { returning: true });

        expect(deleted).toHaveLength(2);
        expect(deleted).toEqual(expect.arrayContaining([first!, second!]));
        expect(await from(tasks).select(db)).toHaveLength(1);
      });

      test('returns only the requested fields', async () => {
        const [first, second, third] = await insertTasks();

        expect(await from(tasks).where('id', '=', first!.id).delete(db, { returning: ['id'] })).toEqual([{ id: first!.id }]);
        expect(await from(tasks).where('id', 'in', [second!.id, third!.id]).delete(db, { returning: [] })).toEqual([{}, {}]);
        expect(sqls.at(-1)).toEndWith(' RETURNING 1');
        expect(await from(tasks).select(db)).toEqual([]);
      });

      test('rejects bounded queries', async () => {
        await expect(from(tasks).limit(1).delete(db)).rejects.toThrow('Cannot delete');
      });
    });

    describe('transaction', () => {
      test('commits', async () => {
        await db.transaction(async tx => {
          await into(tasks).values({ status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() }).insert(tx);
        });

        expect(await from(tasks).select(db)).toHaveLength(1);
      });

      test('rolls back, including nested savepoints', async () => {
        await insertTasks();

        await expect(db.transaction(async tx => {
          await from(tasks).delete(tx);

          await expect(tx.transaction(async sp => {
            await into(tasks).values({ status: 'failed', type: 'x', payload: {}, scheduledAt: new Date() }).insert(sp);
            throw new Error('inner');
          })).rejects.toThrow('inner');

          expect(await from(tasks).select(tx)).toHaveLength(0);
          throw new Error('outer');
        })).rejects.toThrow('outer');

        expect(await from(tasks).select(db)).toHaveLength(3);
      });
    });
  });
}
