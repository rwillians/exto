import { Database as Sqlite } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMigrations } from '../src';
import * as sqlite from '../src/bun-sqlite';
import { migrate } from './fixtures';

// migrates a database file, then inspects it with bun:sqlite directly
describe('migrations', () => {
  let dir: string;
  let file: string;

  const inspect = <T>(sql: string) => {
    const conn = new Sqlite(file, { readonly: true });

    try {
      return conn.query(sql).all() as T[];
    } finally {
      conn.close();
    }
  };

  const columnsOf = (table: string) => inspect<{ name: string }>(`PRAGMA table_info("${table}")`).map(col => col.name);

  const indexesOf = (table: string) => inspect<{ name: string, unique: number }>(`PRAGMA index_list("${table}")`)
    .filter(index => !index.name.startsWith('sqlite_autoindex_'))
    .map(index => ({
      unique: index.unique === 1,
      columns: inspect<{ name: string }>(`PRAGMA index_info("${index.name}")`).map(col => col.name),
    }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exto-'));
    file = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('create tables, with snake_cased column names', async () => {
    await migrate(sqlite.connect(file));

    expect(columnsOf('tasks')).toEqual(['id', 'parent_id', 'status', 'attempts', 'max_attempts', 'payload', 'events', 'created_at', 'updated_at', 'scheduled_to']);
    expect(columnsOf('users')).toEqual(['id', 'name', 'email', 'logins', 'created_at', 'updated_at', 'last_logged_in_at']);
  });

  test('create indexes', async () => {
    await migrate(sqlite.connect(file));

    expect(indexesOf('tasks')).toEqual([{ unique: false, columns: ['status', 'scheduled_to'] }]);
  });

  test('create unique indexes', async () => {
    await migrate(sqlite.connect(file));

    expect(indexesOf('users')).toEqual([{ unique: true, columns: ['email'] }]);
  });

  test('are tracked in schema_migrations', async () => {
    await migrate(sqlite.connect(file));

    const applied = inspect<{ id: string, timestamp: unknown }>('SELECT * FROM "schema_migrations" ORDER BY "id"');

    expect(applied.map(row => row.id)).toEqual(['0001', '0002']);
    expect(applied.every(row => row.timestamp !== null)).toBe(true);
  });

  test('are applied once', async () => {
    const db = sqlite.connect(file);

    await migrate(db);
    await migrate(db);

    expect(inspect('SELECT * FROM "schema_migrations"')).toHaveLength(2);
  });

  test('apply only the pending ones, in order', async () => {
    const db = sqlite.connect(file);
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
    const db = sqlite.connect(file);
    const ran: string[] = [];

    const failing = defineMigrations({
      '0001': async () => { ran.push('0001'); },
      '0002': async () => { throw new Error('boom'); },
      '0003': async () => { ran.push('0003'); },
    });

    await expect(failing(db)).rejects.toThrow('boom');

    expect(ran).toEqual(['0001']);
    expect(inspect<{ id: string }>('SELECT "id" FROM "schema_migrations"').map(row => row.id)).toEqual(['0001']);
  });
});
