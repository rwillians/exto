import { describe, expect, test } from 'bun:test';
import { parse } from '../src';
import { type TaskInsert, type UserInsert, jane, tasks, users } from './fixtures';

describe('parse', () => {
  test('returns a row ready to insert', () => {
    const scheduledTo = new Date();
    const row: TaskInsert = parse(tasks, {
      status: 'scheduled',
      payload: { kind: 'Prune' },
      events: [{ kind: 'scheduled' }],
      scheduledTo,
    });

    expect(row).toMatchObject({ status: 'scheduled', payload: { kind: 'Prune' }, scheduledTo });
  });

  test('fills in the defaults of embedded fields', () => {
    const row = parse(tasks, {
      status: 'scheduled',
      payload: { kind: 'Prune' },
      events: [{ kind: 'scheduled' }],
    });

    expect(row.payload.params).toEqual({});
    expect(row.events[0]).toMatchObject({ kind: 'scheduled', data: {} });
    expect(row.events[0]!.timestamp).toBeInstanceOf(Date);
  });

  test('takes untrusted input', () => {
    const row: UserInsert = parse(users, JSON.parse(JSON.stringify(jane)));

    expect(row).toMatchObject(jane);
  });

  test('rejects missing required fields', () => {
    expect(() => parse(tasks, JSON.parse('{"payload":{"kind":"Prune"},"events":[]}'))).toThrow();
    expect(() => parse(tasks, JSON.parse('{"status":"queued","payload":{},"events":[]}'))).toThrow();
  });

  test('rejects values of the wrong type', () => {
    expect(() => parse(tasks, JSON.parse('{"status":"nope","payload":{"kind":"Prune"},"events":[]}'))).toThrow();
    expect(() => parse(tasks, JSON.parse('{"status":"queued","payload":{"kind":"Prune"},"events":[],"attempts":-1}'))).toThrow();
    expect(() => parse(tasks, JSON.parse('{"status":"queued","payload":{"kind":"Prune"},"events":[{"kind":"nope"}]}'))).toThrow();
  });

  test('rejects values that fail a custom type schema', () => {
    expect(() => parse(users, { ...jane, email: 'not an email' })).toThrow();
  });
});
