// // // // // // // // // // // // // // // // // // // // // // // //
//                       STANDARD SCHEMA SPEC                        //
// // // // // // // // // // // // // // // // // // // // // // // //

// MIT License
//
// Copyright (c) 2024 Colin McDonnell
//
// Permission is hereby granted, free of charge, to any person obtaininga copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> { readonly value: Output; readonly issues?: undefined; }
  export interface FailureResult { readonly issues: ReadonlyArray<Issue>; }
  export interface Issue { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined; }
  export interface PathSegment { readonly key: PropertyKey; }
  export interface Types<Input = unknown, Output = Input> { readonly input: Input; readonly output: Output; }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];

  export {};
}


// // // // // // // // // // // // // // // // // // // // // // // //
//                        STANDARD SCHEMA API                        //
// // // // // // // // // // // // // // // // // // // // // // // //

/**
 * @public  The Standard Schema interface.
 * @since   0.1.0
 * @version 1
 */
export { type StandardSchemaV1 as Schema };

/**
 * @public  Infers the input type of a Standard Schema.
 * @since   0.1.0
 * @version 1
 */
export type input<T extends StandardSchemaV1> = StandardSchemaV1.InferInput<T>;

/**
 * @public  Infers the output type of a Standard Schema.
 * @since   0.1.0
 * @version 1
 */
export type output<T extends StandardSchemaV1> = StandardSchemaV1.InferOutput<T>;

/**
 * @public  Thrown when a value fails validation, carrying every issue found.
 * @since   0.1.0
 * @version 1
 */
export class ValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super('Failed validation:\n' + issues.map(issue => `  - ${formatPath(issue.path)}${issue.message}`).join('\n'));
    this.name = 'ValidationError';
  }
}

/**
 * @public  Use any standard schema to parse a value.
 * @since   0.1.0
 * @version 1
 */
export const parse = <T extends StandardSchemaV1>(schema: T, value: unknown) => {
  const parsed = schema['~standard'].validate(value);

  if (parsed instanceof Promise) {
    throw new Error('async standard schema validators are not supported');
  }

  return parsed as StandardSchemaV1.Result<output<T>>;
};

/**
 * @public  Like {@link parse}, but returns the value or throws a
 *          {@link ValidationError}.
 * @since   0.1.0
 * @version 1
 */
export const parseOrThrow = <T extends StandardSchemaV1>(schema: T, value: unknown): output<T> => {
  const parsed = parse(schema, value);
  if (parsed.issues) throw new ValidationError(parsed.issues);

  return parsed.value;
};

// // // // // // // // // // // // // // // // // // // // // // // //
//                               UTILS                               //
// // // // // // // // // // // // // // // // // // // // // // // //

const formatPath = (path: StandardSchemaV1.Issue['path']) => path && path.length > 0
  ? path.map(segment => String(typeof segment === 'object' ? segment.key : segment)).join('.') + ': '
  : '';

const prependPath = (path: PropertyKey) => (issue: StandardSchemaV1.Issue) => ({
  ...issue,
  path: [path, ...(issue.path ?? [])],
});

const define = <I, O = I>(validate: (input: unknown) => StandardSchemaV1.Result<O>): StandardSchemaV1<I, O> => ({
  '~standard': { version: 1, vendor: 'exto', validate },
});

const fail = (message: string) => ({ issues: [{ message }] });

// // // // // // // // // // // // // // // // // // // // // // // //
//                        BUILT-IN VALIDATORS                        //
// // // // // // // // // // // // // // // // // // // // // // // //

/**
 * @public  Defines an array of a given standard schema.
 * @since   0.1.0
 * @version 1
 */
export const array = <T extends StandardSchemaV1>(schema: T) => define<input<T>[], output<T>[]>((input) => {
  if (!Array.isArray(input)) return fail('must be an array');

  const issues: StandardSchemaV1.Issue[] = [];
  const value: output<T>[] = [];

  input.forEach((item, i) => {
    const parsed = parse(schema, item);
    if (parsed.issues) issues.push(...parsed.issues.map(prependPath(i)));
    else value.push(parsed.value);
  });

  return issues.length > 0
    ? { issues }
    : { value };
});

/**
 * @public  Defines a standard schema for bigints.
 * @since   0.1.0
 * @version 1
 */
export const bigint = () => define<bigint>((input) => typeof input === 'bigint'
  ? { value: input }
  : fail('must be a bigint'));

/**
 * @public  Defines a standard schema for boolean values.
 * @since   0.1.0
 * @version 1
 */
export const boolean = () => define<boolean>((input) => typeof input === 'boolean'
  ? { value: input }
  : fail('must be a boolean'));

/**
 * @public  Defines a standard schema for dates, coercing ISO 8601 strings
 *          and epoch timestamps (in milliseconds) into `Date`.
 * @since   0.1.0
 * @version 1
 */
export const date = () => define<Date | string | number, Date>((input) => {
  const value = input instanceof Date ? input
    : typeof input === 'string' || typeof input === 'number' ? new Date(input)
    : undefined;

  return value && !Number.isNaN(value.getTime())
    ? { value }
    : fail('must be a valid date, ISO 8601 string or epoch timestamp in milliseconds');
});

/**
 * @public  Defines a standard schema for one of the given string values.
 * @since   0.1.0
 * @version 1
 */
export const enumOf = <const T extends readonly string[]>(values: T) => define<T[number]>((input) => values.includes(input as string)
  ? { value: input as T[number] }
  : fail(`must be one of: ${values.join(', ')}`));

/**
 * @public  Defines a standard schema for instances of a given class.
 * @since   0.1.0
 * @version 1
 */
export const instanceOf = <T>(ctor: new (...args: any[]) => T) => define<T>((input) => input instanceof ctor
  ? { value: input }
  : fail(`must be an instance of ${ctor.name}`));

/**
 * @public  Defines a standard schema for integers, within the safe integer
 *          range by default.
 * @since   0.1.0
 * @version 1
 */
export const integer = ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => define<number>((input) => {
  if (!Number.isInteger(input)) return fail('must be an integer');
  if ((input as number) < min) return fail(`must be greater than or equal to ${min}`);
  if ((input as number) > max) return fail(`must be less than or equal to ${max}`);

  return { value: input as number };
});

/**
 * @public  Defines a standard schema for calendar dates as `YYYY-MM-DD`
 *          strings.
 * @since   0.1.0
 * @version 1
 */
export const isoDate = () => define<string>((input) => {
  const valid = typeof input === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(input)
    && new Date(`${input}T00:00:00Z`).toISOString().startsWith(input);

  return valid
    ? { value: input as string }
    : fail('must be a valid date in the YYYY-MM-DD format');
});

/**
 * @public  Makes a given standard schema accept `null`.
 * @since   0.1.0
 * @version 1
 */
export const nullable = <T extends StandardSchemaV1>(schema: T) => define<input<T> | null, output<T> | null>((input) => input === null
  ? { value: null }
  : parse(schema, input));

/**
 * @public  Defines a standard schema for finite numbers.
 * @since   0.1.0
 * @version 1
 */
export const number = () => define<number>((input) => Number.isFinite(input)
  ? { value: input as number }
  : fail('must be a finite number'));

/**
 * @public  Makes a given standard schema accept `undefined`.
 * @since   0.1.0
 * @version 1
 */
export const optional = <T extends StandardSchemaV1>(schema: T) => define<input<T> | undefined, output<T> | undefined>((input) => input === undefined
  ? { value: undefined }
  : parse(schema, input));

/**
 * @public  Defines a standard schema for plain objects with string keys.
 * @since   0.2.0
 * @version 1
 */
export const record = () => define<Record<string, unknown>>((input) => typeof input === 'object' && input !== null && Object.getPrototypeOf(input) === Object.prototype
  ? { value: input as Record<string, unknown> }
  : fail('must be a plain object'));

/**
 * @public  Defines a standard schema for strings, optionally limited in
 *          length.
 * @since   0.1.0
 * @version 1
 */
export const string = ({ max }: { max?: number } = {}) => define<string>((input) => {
  if (typeof input !== 'string') return fail('must be a string');
  if (max !== undefined && input.length > max) return fail(`must be at most ${max} characters long`);

  return { value: input };
});

/**
 * @public  Defines a standard schema for objects of a given shape. Keys
 *          missing from the shape are rejected, keys missing from the input
 *          are validated as `undefined`.
 * @since   0.1.0
 * @version 1
 */
type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : never;
type OptionalKeys<T extends Record<string, StandardSchemaV1>> = { [K in keyof T]: undefined extends input<T[K]> ? K : never }[keyof T];

type ObjectInput<T extends Record<string, StandardSchemaV1>> = Expand<
  { [K in Exclude<keyof T, OptionalKeys<T>>]: input<T[K]> } & { [K in OptionalKeys<T>]?: input<T[K]> }
>;

type ObjectOutput<T extends Record<string, StandardSchemaV1>> = Expand<
  { [K in Exclude<keyof T, OptionalKeys<T>>]: output<T[K]> } & { [K in OptionalKeys<T>]?: output<T[K]> }
>;

export const strictObject = <T extends Record<string, StandardSchemaV1>>(shape: T) => define<ObjectInput<T>, ObjectOutput<T>>((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('must be an object');

  const record = input as Record<string, unknown>;
  const issues: StandardSchemaV1.Issue[] = Object
    .keys(record)
    .filter(key => !(key in shape))
    .map(key => ({ path: [key], message: 'unknown field' }));

  const value: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(shape)) {
    const parsed = parse(schema, record[key]);

    if (parsed.issues && record[key] === undefined) issues.push({ path: [key], message: 'is required' });
    else if (parsed.issues) issues.push(...parsed.issues.map(prependPath(key)));
    else if (parsed.value !== undefined) value[key] = parsed.value;
  }

  return issues.length > 0
    ? { issues }
    : { value: value as ObjectOutput<T> };
});

/**
 * @public  Defines a standard schema for UUID strings (any version).
 * @since   0.1.0
 * @version 1
 */
export const uuid = () => define<string>((input) => typeof input === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
  ? { value: input }
  : fail('must be a valid UUID'));
