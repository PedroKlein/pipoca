import {
  type Static,
  type TNull,
  type TSchema,
  type TUnion,
  Type,
} from "typebox";

type Frozen<T> = T extends object
  ? { readonly [K in keyof T]: Frozen<T[K]> }
  : T;

// What a schema's JSON is in TypeScript, read-only all the way down.
export type Wire<Schema extends TSchema> = Frozen<Static<Schema>>;

export const nonEmpty = Type.String({ minLength: 1 });

export const integer = Type.Integer({
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const strings = Type.Array(Type.String());

export const textMap = Type.Record(Type.String(), Type.String());

export const anyMap = Type.Record(Type.String(), Type.Unknown());

export function nullable<Schema extends TSchema>(
  schema: Schema,
): TUnion<[Schema, TNull]> {
  return Type.Union([schema, Type.Null()]);
}
