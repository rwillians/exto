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

  test('keeps its methods out of its keys', () => {
    for (const method of ['as', 'pick', 'omit']) {
      expect(method in { ...tasks }).toBe(false);
      expect(tasks[method as keyof typeof tasks]).toBeFunction();
    }
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

  test('is narrowed by pick and omit, which leave the table alone', () => {
    expect(Object.keys(tasks.pick(['status', 'id']))).toEqual(['id', 'status']);
    expect(Object.keys(tasks.omit(['events', 'payload']))).toEqual(keys.filter(key => key !== 'events' && key !== 'payload'));
    expect(Object.keys(tasks.omit(['events']).pick(['id']))).toEqual(['id']);
    expect(Object.keys(tasks)).toEqual(keys);
  });

  test('stays narrowed under an alias', () => {
    const t0 = tasks.pick(['id']).as('t0');
    expect(Object.keys(t0)).toEqual(['id']);
    expect(Object.keys({ ...t0 })).toEqual(['id']);
  });

  test('is only narrowed by its columns', () => {
    expect(() => tasks.pick(['nope' as never])).toThrow('Unknown column "nope" in table "tasks"');
    expect(() => tasks.pick(['id']).omit(['status' as never])).toThrow('Unknown column "status" in table "tasks"');
    expect(() => tasks.pick([])).toThrow('No columns of "tasks" are left to read');
    expect(() => tasks.omit(keys as never)).toThrow('No columns of "tasks" are left to read');
  });

  test('reserves its methods\' names', () => {
    // @ts-expect-error "as" can't be a column
    expect(() => table('things', { as: t.string() })).toThrow('"as" is reserved');
    // @ts-expect-error "pick" can't be a column
    expect(() => table('things', { pick: t.string() })).toThrow('"pick" is reserved');
    // @ts-expect-error "omit" can't be a column
    expect(() => table('things', { omit: t.string() })).toThrow('"omit" is reserved');
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

// a table's string keys are its columns, plus its methods
assert<Equals<Exclude<keyof typeof tasks, symbol>, 'as' | 'pick' | 'omit' | keyof Task>>();

// spreading a table leaves its methods out
const spread = { ...tasks };
assert<Equals<Exclude<keyof typeof spread, symbol>, keyof Task>>();

// an aliased table has the same columns
const t0 = tasks.as('t0');
assert<Equals<Exclude<keyof typeof t0, symbol>, 'as' | 'pick' | 'omit' | keyof Task>>();

// a narrowed table has only the columns it kept
const narrowed = tasks.omit(['events']).pick(['id', 'status']).as('t1');
assert<Equals<Exclude<keyof typeof narrowed, symbol>, 'as' | 'pick' | 'omit' | 'id' | 'status'>>();

// @ts-expect-error inferred types live in `Infer`, not on the table
tasks.infer;

// @ts-expect-error unknown columns don't exist on the table
tasks.nope;
