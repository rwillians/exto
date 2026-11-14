import { beforeEach, describe, expect, test } from 'bun:test';
import { from, into } from '../src';
import { jane, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, fresh } from './helpers';

describe('column types', () => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());
  });

  describe('t.uuidv7().generated()', () => {
    test('is generated on insert', async () => {
      const [a, b] = await into(tasks).values([task(), task()]).insert(db);

      expect(a!.id).toBeString();
      expect(a!.id).not.toBe(b!.id);
    });
  });

  describe('t.enum()', () => {
    test('round-trips its values', async () => {
      const [row] = await into(tasks).values(task({ status: 'queued' })).insert(db);

      expect(row!.status).toBe('queued');
    });

    test('rejects values outside of it', async () => {
      const row = JSON.parse('{"status":"nope","payload":{"kind":"Prune"},"events":[]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('t.integer().unsigned()', () => {
    test('takes zero and positives', async () => {
      const [row] = await into(tasks).values(task({ attempts: 0, maxAttempts: 10 })).insert(db);

      expect(row).toMatchObject({ attempts: 0, maxAttempts: 10 });
    });

    test('rejects negatives', async () => {
      await expect(into(tasks).values(task({ attempts: -1 })).insert(db)).rejects.toThrow();
    });

    test('rejects fractions', async () => {
      await expect(into(tasks).values(task({ attempts: 1.5 })).insert(db)).rejects.toThrow();
    });
  });

  describe('t.timestamp()', () => {
    test('round-trips dates to the millisecond', async () => {
      const scheduledTo = new Date('2026-11-14T12:34:56.789Z');
      const [row] = await into(tasks).values(task({ scheduledTo })).insert(db);

      expect(row!.scheduledTo).toEqual(scheduledTo);
      expect((await from(tasks).one(db))!.scheduledTo).toEqual(scheduledTo);
    });
  });

  describe('t.record()', () => {
    test('round-trips objects', async () => {
      const params = { n: 1, list: ['a', 2], nested: { ok: true } };
      await into(tasks).values(task({ payload: { kind: 'Prune', params } })).insert(db);

      expect((await from(tasks).one(db))!.payload.params).toEqual(params);
    });
  });

  describe('.default()', () => {
    test('fills in a static default', async () => {
      const [row] = await into(tasks).values(task()).insert(db);

      expect(row).toMatchObject({ attempts: 0, maxAttempts: 3 });
    });

    test('fills in a function default, once per row', async () => {
      const before = Date.now();
      const [a, b] = await into(tasks).values([task(), task()]).insert(db);
      const after = Date.now();

      expect(a!.createdAt).toBeInstanceOf(Date);
      expect(a!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(a!.createdAt.getTime()).toBeLessThanOrEqual(after);
      expect(a!.createdAt).not.toBe(b!.createdAt);
    });

    test('is overridden by a given value', async () => {
      const scheduledTo = minutesAgo(5);
      const [row] = await into(tasks).values(task({ attempts: 2, scheduledTo })).insert(db);

      expect(row).toMatchObject({ attempts: 2, scheduledTo });
    });
  });

  describe('.optional()', () => {
    test('defaults to null', async () => {
      const [t] = await into(tasks).values(task()).insert(db);
      const [u] = await into(users).values(jane).insert(db);

      expect(t!.parentId).toBeNull();
      expect(u!.lastLoggedInAt).toBeNull();
    });

    test('takes a value', async () => {
      const [parent] = await into(tasks).values(task()).insert(db);
      const [child] = await into(tasks).values(task({ parentId: parent!.id })).insert(db);

      expect(child!.parentId).toBe(parent!.id);
    });
  });

  describe('embedded.one()', () => {
    test('round-trips an object, filling in its defaults', async () => {
      await into(tasks).values(task({ payload: { kind: 'Prune' } })).insert(db);

      expect((await from(tasks).one(db))!.payload).toEqual({ kind: 'Prune', params: {} });
    });

    test('validates its fields', async () => {
      const row = JSON.parse('{"status":"queued","payload":{"kind":1},"events":[]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('embedded.many()', () => {
    test('round-trips a list of objects, filling in their defaults', async () => {
      const timestamp = new Date('2026-11-14T00:00:00.000Z');
      await into(tasks).values(task({ events: [{ kind: 'scheduled' }, { kind: 'queued', data: { by: 'cron' }, timestamp }] })).insert(db);

      const [scheduled, queued] = (await from(tasks).one(db))!.events;

      expect(scheduled).toMatchObject({ kind: 'scheduled', data: {} });
      expect(scheduled!.timestamp).toBeInstanceOf(Date);
      expect(queued).toEqual({ kind: 'queued', data: { by: 'cron' }, timestamp });
    });

    test('round-trips an empty list', async () => {
      await into(tasks).values(task({ events: [] })).insert(db);

      expect((await from(tasks).one(db))!.events).toEqual([]);
    });

    test('validates every item', async () => {
      const row = JSON.parse('{"status":"queued","payload":{"kind":"Prune"},"events":[{"kind":"scheduled"},{"kind":"nope"}]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('defineType()', () => {
    test('stores values as its primitive', async () => {
      const [row] = await into(users).values(jane).insert(db);

      expect(row!.email).toBe('jane.doe@example.com');
    });

    test('validates values with its schema', async () => {
      await expect(into(users).values({ ...jane, email: 'not an email' }).insert(db)).rejects.toThrow();
    });
  });
});
