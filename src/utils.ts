export type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : never;

export type CamelCase<S extends string> = S extends `${infer T}_${infer U}`
  ? `${T}${Capitalize<CamelCase<U>>}`
  : S;

export const camelCase = <T extends string>(str: T) => str.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase()) as CamelCase<T>;

export const snakeCase = (str: string) => str.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

export const wrap = <T>(value: T | T[]): T[] => Array.isArray(value)
  ? value
  : [value];
