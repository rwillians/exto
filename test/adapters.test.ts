import { beforeEach, describe, expect, test } from 'bun:test';
import { ValidationError, create, exec, expr, from, into, type ColumnRef, type IDatabase } from '../src';
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
      await pgdb.execute('CREATE EXTENSION IF NOT EXISTS citext', []);
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
      test('can run raw statements', async () => {
        await insertTasks();

        expect(await exec(db, 'CREATE INDEX "tasks_type_index" ON "tasks" ("type")')).toBeUndefined();
        expect(sqls.at(-1)).toBe('CREATE INDEX "tasks_type_index" ON "tasks" ("type")');

        await exec(db, `UPDATE "tasks" SET "type" = ${db.dialect.placeholder(1)}`, ['Raw']);
        expect(await from(tasks).where('type', '=', 'Raw').count(db)).toBe(3);
      });

      test('are applied once', async () => {
        await migrate(db);
        expect(await from(tasks).all(db)).toEqual([]);
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

      test('inserts into an aliased table', async () => {
        const [task] = await into(tasks.as('t')).values({ status: 'queued', type: 'x', payload: {}, scheduledAt: new Date() }).insert(db, { returning: ['type'] });

        expect(task).toEqual({ type: 'x' });
        expect(sqls.at(-1)).toStartWith('INSERT INTO "tasks" (');
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
        expect(await from(tasks).select(['type']).all(db)).toEqual([{ type: 'x' }]);
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
        expect(await from(tasks).orderBy(['type']).select(['type']).all(db)).toEqual([{ type: 'x' }, { type: 'y' }]);
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
        expect(await from(tasks).all(db)).toEqual([]);
      });

      test('validates json columns with third-party standard schemas', async () => {
        const row = { day: '2026-11-12', amount: 1, ratio: 1, big: 1, body: 'hi' };

        // `doc` is a zod schema
        await expect(into(things).values({ ...row, doc: { a: ['nope'] } } as any).insert(db)).rejects.toBeInstanceOf(ValidationError);
        expect(await into(things).values({ ...row, doc: { a: [1] } }).insert(db)).toHaveLength(1);
      });

      test('keeps bigints exact', async () => {
        const row = { day: '2026-11-13', amount: 1, ratio: 1, big: 1, doc: { a: [] }, body: 'a', huge: 2n ** 53n + 1n };
        await into(things).values([row, { ...row, big: 2, body: 'b', huge: -(2n ** 62n) }]).insert(db);

        expect(await from(things).where('huge', '>', 2n ** 53n).select(['huge']).all(db)).toEqual([{ huge: 2n ** 53n + 1n }]);
        expect(await from(things).where('huge', '>', 2n ** 53n).update(db, { inc: { huge: 1 }, returning: ['huge'] })).toEqual([{ huge: 2n ** 53n + 2n }]);
        await expect(into(things).values({ ...row, big: 3, body: 'c', huge: 1 as any }).insert(db)).rejects.toBeInstanceOf(ValidationError);
      });

      test('gives decimals a precision and scale on postgres', () => {
        const ddl = sqls.find(sql => sql.startsWith('CREATE TABLE "things"'));

        expect(ddl).toContain(db.dialect.name === 'postgres' ? '"price" NUMERIC(10, 2)' : '"price" NUMERIC)');
        expect(ddl).toContain('"amount" NUMERIC NOT NULL');
      });

      test('compares citext case-insensitively', async () => {
        const row = { day: '2026-11-13', amount: 1, ratio: 1, big: 1, doc: { a: [] }, body: 'a', label: 'Jane@Example.com' };
        await into(things).values(row).insert(db);
        await create.uniqueIndex(things, ['label']).onto(db);

        expect(await from(things).where('label', '=', 'jane@example.com').select(['label']).all(db)).toEqual([{ label: 'Jane@Example.com' }]);
        await expect(into(things).values({ ...row, big: 2, body: 'b', label: 'JANE@example.com' }).insert(db)).rejects.toThrow();
      });

      test('round-trips every primitive', async () => {
        const row = { blob: new Uint8Array([1, 2, 255]), day: '2026-11-12', amount: 12.5, ratio: -0.25, big: 2 ** 40, doc: { a: [1, 2] }, body: 'hi', label: 'Hi There', huge: 2n ** 63n - 1n, price: 12.34 };
        const [thing] = await into(things).values(row).insert(db);

        expect(thing).toEqual({ seq: 1, flag: false, list: ['x', 1], ...row, blob: expect.any(Uint8Array) });
        expect([...thing!.blob!]).toEqual([1, 2, 255]);

        const [again] = await from(things)
          .where('flag', '=', false)
          .where('day', '=', '2026-11-12')
          .where('big', '>', 2 ** 39)
          .all(db);

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
        expect(await from(things).orderBy(['big']).select(['body']).all(db)).toEqual([{ body: 'a' }, { body: 'c' }]);
      });

      test('throws', async () => {
        await into(things).values(row).insert(db);

        await expect(into(things).values({ ...row, body: 'b' }).insert(db, { conflict: { on: ['day', 'big'], do: 'throw' } })).rejects.toThrow();
        expect(sqls.at(-1)).not.toContain('ON CONFLICT');
        expect(await from(things).select(['body']).all(db)).toEqual([{ body: 'a' }]);
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

        // two rows' worth of params come before the ones in DO UPDATE
        const n = 2 * (Object.values(things) as ColumnRef[]).map(ref => ref.col).filter(col => !('generated' in col)).length;
        expect(sqls.at(-1)).toContain(` DO UPDATE SET "flag" = ${db.dialect.placeholder(n + 1)}, "amount" = "things"."amount" + ${db.dialect.placeholder(n + 2)} RETURNING `);
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
        const due = await from(tasks).where('scheduledAt', '<', new Date()).orderBy([['scheduledAt', 'DESC']]).all(db);

        expect(due.map(task => task.id)).toEqual([second!.id, first!.id]);
      });

      test('limits and offsets', async () => {
        const [, , third] = await insertTasks();

        expect(await from(tasks).where('scheduledAt', '<', new Date()).limit(1).offset(0).all(db)).toHaveLength(1);
        expect(await from(tasks).orderBy(['scheduledAt']).offset(2).select(['id']).all(db)).toEqual([{ id: third!.id }]);
      });

      test('picks columns', async () => {
        await insertTasks();
        const rows = await from(tasks.as('t')).where('type', 'like', 'Pru%').select(['id', 'type']).all(db);

        expect(rows).toHaveLength(2);
        expect(Object.keys(rows[0]!)).toEqual(['id', 'type']);
      });

      test('selects before or after filtering', async () => {
        await insertTasks();

        const before = await from(tasks).select(['type']).where('status', '=', 'queued').all(db);
        const after = await from(tasks).where('status', '=', 'queued').select(['type']).all(db);

        expect(before).toEqual([{ type: 'Other' }]);
        expect(after).toEqual(before);
      });

      test('fetches only the top row', async () => {
        const [first, second] = await insertTasks();
        const ordered = from(tasks).orderBy(['scheduledAt']);

        expect(await ordered.one(db)).toEqual(first!);
        expect(sqls.at(-1)).toEndWith(` LIMIT ${db.dialect.placeholder(1)}`);
        expect(await ordered.offset(1).select(['id']).one(db)).toEqual({ id: second!.id });
        expect(await ordered.where('status', '=', 'failed').one(db)).toBeNull();
        expect(await ordered.offset(3).one(db)).toBeNull();
        expect(await ordered.limit(0).one(db)).toBeNull();
      });

      test('returns an empty object per row given no columns', async () => {
        await insertTasks();

        expect(await from(tasks.as('t')).where('type', '=', 'Prune').select([]).all(db)).toEqual([{}, {}]);
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

        expect(await from(tasks).where('status', 'in', []).all(db)).toHaveLength(0);
        expect(await from(tasks).where('status', 'not in', []).all(db)).toHaveLength(3);
        expect(await from(tasks).where('status', 'not in', ['queued']).where('parentId', 'is', null).all(db)).toHaveLength(2);
        expect(await from(tasks).where('parentId', 'is not', null).all(db)).toHaveLength(0);
      });

      test('supports or and and groups', async () => {
        const [first, second, third] = await insertTasks();
        const p = (n: number) => db.dialect.placeholder(n);

        const anyOf = await from(tasks)
          .where(expr.or([expr('status', '=', 'queued'), expr('scheduledAt', '<', new Date())]))
          .select(['id']).all(db);

        expect(anyOf.map(task => task.id).sort()).toEqual([first!.id, second!.id, third!.id].sort());

        const nested = await from(tasks)
          .where('type', '=', 'Prune')
          .where(expr.or([
            expr.and([expr('status', '=', 'scheduled'), expr('attempts', '=', 0)]),
            expr('status', '=', 'queued'),
          ]))
          .select(['id']).all(db);

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

        expect(await from(tasks).where(expr.or([])).all(db)).toHaveLength(0);
        expect(await from(tasks).where(expr.and([])).all(db)).toHaveLength(3);
      });

      test('rejects unknown keys in expressions', () => {
        expect(() => from(tasks).where(expr.or([expr('nope' as any, '=', 1)]))).toThrow();
      });

      test('filters by column references, against values or other columns', async () => {
        const [first, second, third] = await insertTasks();
        const p = (n: number) => db.dialect.placeholder(n);

        // only the third task is scheduled after it was created
        expect(await from(tasks).where(tasks.createdAt, '<', tasks.scheduledAt).select(['id']).all(db)).toEqual([{ id: third!.id }]);
        expect(sqls.at(-1)).toBe('SELECT "tasks"."id" AS "id" FROM "tasks" AS "tasks" WHERE "tasks"."created_at" < "tasks"."scheduled_at"');

        const t = tasks.as('t');

        const rows = await from(t)
          .where(t.type, '=', 'Other')
          .where(t.createdAt, '<', t.scheduledAt)
          .orderBy([[t.scheduledAt, 'DESC'], 'id'])
          .select(['id'])
          .all(db);

        expect(rows).toEqual([{ id: third!.id }]);
        expect(sqls.at(-1)).toBe(`SELECT "t"."id" AS "id" FROM "tasks" AS "t" WHERE "t"."type" = ${p(1)} AND "t"."created_at" < "t"."scheduled_at" ORDER BY "t"."scheduled_at" DESC, "t"."id" ASC`);

        const grouped = await from(t)
          .where(expr.or([expr(t.createdAt, '>=', t.scheduledAt), expr(t.status, 'in', ['queued'])]))
          .all(db);

        expect(grouped.map(task => task.id).sort()).toEqual([first!.id, second!.id, third!.id].sort());
      });

      test('selects column references under keys of its own', async () => {
        const [, , third] = await insertTasks();
        const t = tasks.as('t');

        const renamed = await from(tasks).where('type', '=', 'Other').select({ taskId: tasks.id, when: tasks.scheduledAt }).all(db);

        expect(renamed).toEqual([{ taskId: third!.id, when: new Date('2099-01-01T00:00:00Z') }]);
        expect(sqls.at(-1)).toStartWith('SELECT "tasks"."id" AS "taskId", "tasks"."scheduled_at" AS "when" FROM "tasks" AS "tasks"');
        expect(await from(t).where(t.type, '=', 'Other').select({ ...t }).one(db)).toEqual(third!);
        expect(await from(t).select({}).all(db)).toEqual([{}, {}, {}]);
        expect(await from(t).select({ id: t.id }).where('type', '=', 'Other').count(db)).toBe(1);
      });

      test('rejects references to another alias or table', () => {
        const t = tasks.as('t');

        expect(() => from(tasks.as('u')).where(t.status as any, '=', 'queued')).toThrow(`"t.status" isn't part of the query`);
        expect(() => from(tasks).where(t.createdAt as any, '<', t.scheduledAt as any)).toThrow(`"t.createdAt" isn't part of the query`);
        expect(() => from(t).where(expr(things.as('t').body as any, '=', 'x'))).toThrow(`"t.body" isn't part of the query`);
        expect(() => from(t).orderBy([tasks.as('u').id as any])).toThrow(`"u.id" isn't part of the query`);
        expect(() => from(t).select({ id: tasks.id as any })).toThrow(`"tasks.id" isn't part of the query`);
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
        expect(await scheduled.select(['type']).all(db)).toEqual([{ type: 'z' }, { type: 'z' }]);
      });

      test('filters with expressions', async () => {
        await insertTasks();
        const updated = await from(tasks)
          .where(expr.or([expr('status', '=', 'queued'), expr('attempts', '>', 0)]))
          .update(db, { inc: { attempts: 1 }, returning: ['attempts'] });

        expect(updated).toEqual([{ attempts: 6 }]);
        expect(await from(tasks).where(expr.or([expr('type', '=', 'Other'), expr('parentId', 'is not', null)])).delete(db, { returning: ['type'] })).toEqual([{ type: 'Other' }]);
      });

      test('filters by column references', async () => {
        const [, , third] = await insertTasks();
        const t = tasks.as('t');
        const query = from(t).where(t.createdAt, '<', t.scheduledAt);

        expect(await from(tasks).where(tasks.createdAt, '<', tasks.scheduledAt).update(db, { inc: { attempts: 1 }, returning: ['attempts'] })).toEqual([{ attempts: 6 }]);
        expect(sqls.at(-1)).toContain(' WHERE "created_at" < "scheduled_at" RETURNING ');

        expect(await query.update(db, { set: { status: 'running' }, returning: ['id'] })).toEqual([{ id: third!.id }]);
        expect(await query.delete(db, { returning: ['status'] })).toEqual([{ status: 'running' }]);
        expect(sqls.at(-1)).toBe('DELETE FROM "tasks" WHERE "created_at" < "scheduled_at" RETURNING "status" AS "status"');
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
        expect(await from(tasks).all(db)).toHaveLength(1);
      });

      test('returns the deleted rows given returning: true', async () => {
        const [first, second] = await insertTasks();
        const deleted = await from(tasks.as('t')).where('status', '=', 'scheduled').delete(db, { returning: true });

        expect(deleted).toHaveLength(2);
        expect(deleted).toEqual(expect.arrayContaining([first!, second!]));
        expect(await from(tasks).all(db)).toHaveLength(1);
      });

      test('returns only the requested fields', async () => {
        const [first, second, third] = await insertTasks();

        expect(await from(tasks).where('id', '=', first!.id).delete(db, { returning: ['id'] })).toEqual([{ id: first!.id }]);
        expect(await from(tasks).where('id', 'in', [second!.id, third!.id]).delete(db, { returning: [] })).toEqual([{}, {}]);
        expect(sqls.at(-1)).toEndWith(' RETURNING 1');
        expect(await from(tasks).all(db)).toEqual([]);
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

        expect(await from(tasks).all(db)).toHaveLength(1);
      });

      test('rolls back, including nested savepoints', async () => {
        await insertTasks();

        await expect(db.transaction(async tx => {
          await from(tasks).delete(tx);

          await expect(tx.transaction(async sp => {
            await into(tasks).values({ status: 'failed', type: 'x', payload: {}, scheduledAt: new Date() }).insert(sp);
            throw new Error('inner');
          })).rejects.toThrow('inner');

          expect(await from(tasks).all(tx)).toHaveLength(0);
          throw new Error('outer');
        })).rejects.toThrow('outer');

        expect(await from(tasks).all(db)).toHaveLength(3);
      });
    });
  });
}
