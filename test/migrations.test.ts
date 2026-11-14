import { beforeEach, expect, test } from 'bun:test';
import { create, defineMigrations } from '../src';
import { migrate, tasks } from './fixtures';
import { type Database, suite } from './helpers';

// reads the schema back from the database's own catalog
suite('migrations', (fresh, { columnsOf, indexesOf }) => {
  let db: Database;

  const applied = async () => (await db.execute('SELECT "id", "timestamp" FROM "schema_migrations" ORDER BY "id"', []));

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
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
});
