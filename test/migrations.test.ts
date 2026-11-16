import { beforeEach, expect, test } from 'bun:test';
import { create, defineMigrations, exec, file } from '../src';
import { migrate, tasks } from './fixtures';
import { type Database, suite } from './helpers';

// reads the schema back from the database's own catalog
suite('migrations', (fresh, { name, columnsOf, indexesOf }) => {
  let db: Database;
  let sqls: string[];

  const applied = async () => (await db.execute('SELECT "id", "timestamp" FROM "schema_migrations" ORDER BY "id"', []));

  beforeEach(async () => {
    ({ db, sqls } = await fresh({ migrate: false }));
  });

  test('create tables, with snake_cased column names', async () => {
    await migrate(db);

    expect(await columnsOf(db, 'tasks')).toEqual(['id', 'parent_id', 'status', 'attempts', 'max_attempts', 'payload', 'events', 'created_at', 'updated_at', 'scheduled_to']);
    expect(await columnsOf(db, 'users')).toEqual(['id', 'name', 'email', 'logins', 'created_at', 'updated_at', 'last_logged_in_at']);
  });

  test('create indexes', async () => {
    await migrate(db);

    expect(await indexesOf(db, 'tasks')).toEqual([{ unique: false, columns: ['status', 'scheduled_to'] }]);
  });

  test('create unique indexes', async () => {
    await migrate(db);

    expect(await indexesOf(db, 'users')).toEqual([{ unique: true, columns: ['email'] }]);
  });

  test('are tracked in schema_migrations', async () => {
    await migrate(db);

    const rows = await applied();

    expect(rows.map(row => row['id'])).toEqual(['0001', '0002']);
    expect(rows.every(row => row['timestamp'] !== null)).toBe(true);
  });

  test('are applied once', async () => {
    await migrate(db);
    await migrate(db);

    expect(await applied()).toHaveLength(2);
  });

  test('apply only the pending ones, in order', async () => {
    const ran: string[] = [];

    await defineMigrations({
      '0001': async () => { ran.push('0001'); },
    })(db);

    await defineMigrations({
      '0003': async () => { ran.push('0003'); },
      '0001': async () => { ran.push('0001'); },
      '0002': async () => { ran.push('0002'); },
    })(db);

    expect(ran).toEqual(['0001', '0002', '0003']);
  });

  test('stop at the first failure, keeping the ones before it', async () => {
    const ran: string[] = [];

    const failing = defineMigrations({
      '0001': async () => { ran.push('0001'); },
      '0002': async () => { throw new Error('boom'); },
      '0003': async () => { ran.push('0003'); },
    });

    await expect(failing(db)).rejects.toThrow('boom');

    expect(ran).toEqual(['0001']);
    expect((await applied()).map(row => row['id'])).toEqual(['0001']);
  });

  test('roll back the statements of a failed migration', async () => {
    const failing = defineMigrations({
      '0001': async (db) => {
        await create.table(tasks).onto(db);
        throw new Error('boom');
      },
    });

    await expect(failing(db)).rejects.toThrow('boom');

    expect(await columnsOf(db, 'tasks')).toEqual([]);
    expect(await applied()).toEqual([]);
  });

  test('run every statement of a SQL file, then data migrations', async () => {
    await defineMigrations({
      '0001': async (db) => {
        await file(db, 'test/sql/things.sql');
        await exec(db, 'UPDATE "things" SET "body" = "body" || \'!\'');
      },
    })(db);

    expect(await columnsOf(db, 'things')).toEqual(['id', 'body']);
    expect(await db.execute('SELECT "body" FROM "things"', [])).toEqual([{ body: 'a; b!' }]);
    expect(sqls).toEqual(expect.arrayContaining([
      expect.stringMatching(/^-- two statements[\s\S]{0,}CREATE TABLE "things" \("id" INTEGER PRIMARY KEY, "body" TEXT NOT NULL\)$/),
      'INSERT INTO "things" ("id", "body") VALUES (1, \'a; b\')',
    ]));
  });

  test('read a SQL file from a URL', async () => {
    await file(db, new URL('./sql/things.sql', import.meta.url));
    expect(await columnsOf(db, 'things')).toEqual(['id', 'body']);
  });

  test('roll back every statement of a failed SQL file', async () => {
    await expect(defineMigrations({ '0001': async (db) => file(db, 'test/sql/failing.sql') })(db)).rejects.toThrow('nope');

    expect(await columnsOf(db, 'things')).toEqual([]);
    expect(await applied()).toEqual([]);
  });

  test('skip a SQL file with nothing but comments', async () => {
    const count = sqls.length;
    await file(db, 'test/sql/comments.sql');
    expect(sqls).toHaveLength(count);
  });

  test.skipIf(name !== 'bun-postgres')("keep a dollar-quoted body's semicolons in its statement", async () => {
    await file(db, 'test/sql/function.sql');
    expect(await db.execute('SELECT "body" FROM "things" ORDER BY "id"', [])).toEqual([{ body: 'a' }, { body: 'b' }]);
  });

  test("refuse a SQL file that doesn't exist", async () => {
    await expect(file(db, 'test/sql/missing.sql')).rejects.toThrow('ENOENT');
  });
});

suite('exec', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
  });

  test('runs a statement, ignoring semicolons in quotes and comments', async () => {
    await exec(db, 'CREATE TABLE "things" ("id" INTEGER, "body" TEXT); -- a trailing; comment');
    await exec(db, 'INSERT INTO "things" ("id", "body") VALUES (1, \'a; \'\'b\'\'\') /* c; */;');

    expect(await db.execute('SELECT "body" FROM "things"', [])).toEqual([{ body: "a; 'b'" }]);
  });

  test('refuses more than one statement', async () => {
    await expect(exec(db, 'CREATE TABLE "things" ("id" INTEGER); DROP TABLE "things"'))
      .rejects.toThrow('"exec" runs a single statement, got 2: run a script with "file"');
  });
});
