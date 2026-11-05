import { owner } from "@pipoca/protocol";
import {
  type Static,
  type TArray,
  type TBoolean,
  type TLiteral,
  type TNumber,
  type TObject,
  type TProperties,
  type TString,
  type TUnion,
  type TUnsafe,
  Type,
} from "typebox";

export type TConfig = TObject;

export type TSecret = TUnsafe<string>;

export type TCollection<I extends TObject> = TArray<I>;

export type TAudience = TArray<typeof owner>;

export interface EventDef<F extends TObject = TObject> {
  readonly title: string;
  readonly description?: string;
  readonly fields: F;
}

export type Events = Readonly<Record<string, EventDef>>;

export interface PluginDefinition<
  C extends TConfig = TConfig,
  E extends Events = Events,
> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly works?: readonly ("personal" | "team")[];
  readonly defaultOn?: "always" | "solo" | "team" | "never";
  readonly requires?: Readonly<Record<string, "required" | "optional">>;
  readonly config?: C;
  readonly schema?: string;
  readonly events?: E;
  // A part's module imports its definition, so typing it here would be a
  // cycle; the host checks it is the part its define function made for the
  // plugin.
  readonly server?: () => Promise<{ readonly default: unknown }>;
  readonly session?: () => Promise<{ readonly default: unknown }>;
  readonly web?: () => Promise<{ readonly default: unknown }>;
}

const idPattern = /^[a-z][a-z0-9-]*$/;

export function definePlugin<const P extends PluginDefinition>(plugin: P): P {
  if (!idPattern.test(plugin.id)) {
    throw new Error(
      `plugin id ${plugin.id} must be lowercase letters, digits and hyphens, starting with a letter`,
    );
  }

  return plugin;
}

export const annotation = "x-pipoca";

export const Config = {
  object: <P extends TProperties>(properties: P): TObject<P> =>
    Type.Object(properties, { default: {} }),

  string: (o: {
    readonly title: string;
    readonly description?: string;
    readonly default: string;
    readonly hidden?: boolean;
  }): TString =>
    Type.String({
      title: o.title,
      default: o.default,
      ...(o.description !== undefined && { description: o.description }),
      ...(o.hidden === true && { [annotation]: { hidden: true } }),
    }),

  number: (o: {
    readonly title: string;
    readonly default: number;
    readonly min?: number;
    readonly max?: number;
  }): TNumber =>
    Type.Number({
      title: o.title,
      default: o.default,
      ...(o.min !== undefined && { minimum: o.min }),
      ...(o.max !== undefined && { maximum: o.max }),
    }),

  boolean: (o: {
    readonly title: string;
    readonly default: boolean;
  }): TBoolean => Type.Boolean({ title: o.title, default: o.default }),

  choice: <const T extends readonly string[]>(o: {
    readonly title: string;
    readonly options: T;
    readonly default: T[number];
  }): TUnion<TLiteral<T[number]>[]> =>
    Type.Union(
      o.options.map((option: T[number]) => Type.Literal(option)),
      { title: o.title, default: o.default },
    ),

  strings: (o: {
    readonly title: string;
    readonly default: readonly string[];
  }): TArray<TString> =>
    Type.Array(Type.String(), { title: o.title, default: o.default }),

  collection: <I extends TObject>(o: {
    readonly key: keyof Static<I> & string;
    readonly item: I;
    readonly admin?: boolean;
    readonly title: string;
  }): TCollection<I> =>
    Type.Array(o.item, {
      title: o.title,
      default: [],
      [annotation]: { collection: { key: o.key, admin: o.admin === true } },
    }),

  audience: (): TAudience => Type.Array(owner, { default: [] }),
};

const secretRef = Type.Union([
  Type.Object({ sealed: Type.String() }, { additionalProperties: false }),
  Type.Object({ env: Type.String() }, { additionalProperties: false }),
]);

export function Secret(
  o: { readonly title?: string; readonly env?: boolean } = {},
): TSecret {
  return Type.Unsafe<string>({
    ...secretRef,
    ...(o.title !== undefined && { title: o.title }),
    [annotation]: { secret: { env: o.env === true } },
  });
}

export function event<F extends TObject>(o: {
  readonly title: string;
  readonly description?: string;
  readonly fields: F;
}): EventDef<F> {
  return o;
}
