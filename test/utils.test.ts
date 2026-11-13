import { describe, expect, test } from 'bun:test';
import { raise } from '../src/utils';

const caught = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }

  throw new Error('expected a throw');
};

describe('raise', () => {
  const cause = new Error('root');

  test('throws an Error with a message and an optional cause', () => {
    expect(caught(() => raise('boom'))).toEqual(new Error('boom'));
    expect(caught(() => raise('boom', cause)).cause).toBe(cause);
  });

  test('throws an instance of the given class', () => {
    const error = caught(() => raise(TypeError, 'wrong type', cause));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('wrong type');
    expect(error.cause).toBe(cause);
  });

  test('works where throw is not allowed', () => {
    const value = undefined as string | undefined;

    expect(caught(() => value ?? raise('missing value')).message).toBe('missing value');
  });
});
