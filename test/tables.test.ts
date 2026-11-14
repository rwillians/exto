import { describe, expect, test } from 'bun:test';
import { table } from '../src';
import { tasks } from './fixtures';

const keys = ['id', 'parentId', 'status', 'type', 'payload', 'attempts', 'createdAt', 'scheduledAt'];

describe('table', () => {
  test('is shaped like its columns', () => {
    expect(Object.keys(tasks)).toEqual(keys);
    expect(Object.keys({ ...tasks })).toEqual(keys);
    expect(tasks.scheduledAt).toMatchObject({ alias: 'tasks', col: { key: 'scheduledAt', name: 'scheduled_at' } });
  });

  test('references its columns under another alias', () => {
    const t = tasks.as('t');

    expect(Object.keys(t)).toEqual(keys);
    expect(t.scheduledAt).toMatchObject({ alias: 't', col: tasks.scheduledAt.col });
    expect(t.as('u').id.alias).toBe('u');
  });

  test('reserves "as"', () => {
    // @ts-expect-error "as" can't be a column
    expect(() => table('things', t => ({ as: t.text() }))).toThrow(`"as" is reserved, it can't be a column of table "things"`);
  });
});
