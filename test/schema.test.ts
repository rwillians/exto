import { describe, expect, test } from 'bun:test';
import { table, t } from '../src';
import { type EventKind, type Status, type Task, type TaskInsert, type TaskUpdate, type User, type UserInsert, type UserUpdate, tasks, users } from './fixtures';
import { type Equals, type OptionalKeys, type RequiredKeys, assert } from './helpers';

const keys = ['id', 'parentId', 'status', 'attempts', 'maxAttempts', 'payload', 'events', 'createdAt', 'updatedAt', 'scheduledTo'];

describe('table', () => {
  test('is shaped like its columns', () => {
    expect(Object.keys(tasks)).toEqual(keys);
    expect(Object.keys({ ...tasks })).toEqual(keys);
  });

  test('keeps "as" out of its keys', () => {
    expect('as' in { ...tasks }).toBe(false);
    expect(tasks.as).toBeFunction();
  });

  test('is shaped like its columns under an alias too', () => {
    const t0 = tasks.as('t0');

    expect(Object.keys(t0)).toEqual(keys);
    expect(Object.keys(t0.as('t1'))).toEqual(keys);
  });

  test('aliasing leaves the original table alone', () => {
    tasks.as('t0');

    expect(Object.keys(tasks)).toEqual(keys);
    expect(tasks.id).not.toBe(tasks.as('t0').id);
  });

  test('reserves "as"', () => {
    // @ts-expect-error "as" can't be a column
    expect(() => table('things', { as: t.string() })).toThrow('"as" is reserved');
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

assert<Equals<Task, {
  id: string;
  parentId: string | null;
  status: Status;
  attempts: number;
  maxAttempts: number;
  payload: { kind: string; params: Record<string, unknown> };
  events: { kind: EventKind; data: Record<string, unknown>; timestamp: Date }[];
  createdAt: Date;
  updatedAt: Date;
  scheduledTo: Date;
}>>();

assert<Equals<User, {
  id: string;
  name: string;
  email: string;
  logins: number;
  createdAt: Date;
  updatedAt: Date;
  lastLoggedInAt: Date | null;
}>>();

// inserts require columns with neither a default nor `optional()`, and leave generated ones out
assert<Equals<RequiredKeys<TaskInsert>, 'status' | 'payload' | 'events'>>();
assert<Equals<OptionalKeys<TaskInsert>, 'parentId' | 'attempts' | 'maxAttempts' | 'createdAt' | 'updatedAt' | 'scheduledTo'>>();
assert<Equals<RequiredKeys<TaskInsert['payload']>, 'kind'>>();
assert<Equals<OptionalKeys<TaskInsert['payload']>, 'params'>>();
assert<Equals<RequiredKeys<TaskInsert['events'][number]>, 'kind'>>();
assert<Equals<OptionalKeys<TaskInsert['events'][number]>, 'data' | 'timestamp'>>();
assert<Equals<RequiredKeys<UserInsert>, 'name' | 'email'>>();
assert<Equals<OptionalKeys<UserInsert>, 'logins' | 'createdAt' | 'updatedAt' | 'lastLoggedInAt'>>();

// optional columns take null
const _orphan: TaskInsert = { status: 'queued', payload: { kind: 'Prune' }, events: [], parentId: null };

// updates take any column but the primary key, all of them optional
assert<Equals<keyof TaskUpdate, Exclude<keyof Task, 'id'>>>();
assert<Equals<RequiredKeys<TaskUpdate>, never>>();
assert<Equals<keyof UserUpdate, Exclude<keyof User, 'id'>>>();
assert<Equals<RequiredKeys<UserUpdate>, never>>();

// a table's string keys are its columns, plus `as`
assert<Equals<Exclude<keyof typeof tasks, symbol>, 'as' | keyof Task>>();

// spreading a table leaves `as` out
const spread = { ...tasks };
assert<Equals<Exclude<keyof typeof spread, symbol>, keyof Task>>();

// an aliased table has the same columns
const t0 = tasks.as('t0');
assert<Equals<Exclude<keyof typeof t0, symbol>, 'as' | keyof Task>>();

// @ts-expect-error inferred types live in `Infer`, not on the table
tasks.infer;

// @ts-expect-error unknown columns don't exist on the table
tasks.nope;
