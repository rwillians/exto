type Ctor<T> = new (...args: any[]) => T;

export type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : never;

export type CamelCase<S extends string> = S extends `${infer T}_${infer U}`
  ? `${T}${Capitalize<CamelCase<U>>}`
  : S;

export const camelCase = <T extends string>(str: T) => str.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase()) as CamelCase<T>;

export const snakeCase = (str: string) => str.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

export const wrap = <T>(value: T | T[]): T[] => Array.isArray(value)
  ? value
  : [value];

export function raise(message: string, cause?: Error): never;
export function raise(ctor: Ctor<Error>, message: string, cause?: Error): never;

export function raise(ctorOrMessage: Ctor<Error> | string, messageOrCause?: string | Error, cause?: Error): never {
  if (typeof ctorOrMessage === 'string') throw new Error(ctorOrMessage, { cause: messageOrCause });
  throw new ctorOrMessage(messageOrCause, { cause });
}
