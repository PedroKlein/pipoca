import { owner } from "@pipoca/protocol";
import {
  type Static,
  type TArray,
  type TBoolean,
  type TInteger,
  type TLiteral,
  type TNumber,
  type TObject,
  type TProperties,
  type TString,
  type TUnion,
  type TUnsafe,
  Type,
} from "typebox";

type TConfig = TObject;

type TSecret = TUnsafe<string>;

type TCollection<I extends TObject> = TArray<I>;

type TAudience = TArray<typeof owner>;

export interface EventDef<F extends TObject = TObject> {
  readonly title: string;
  readonly description?: string;
  readonly fields: F;
}

export type Events = Readonly<Record<string, EventDef>>;

// What a routine's run may propose for the plugin to write outside, such as
// a comment, which the plugin applies as the identity the run acts as
// (ADR 0076).
export interface ActionDef<I extends TObject = TObject> {
  readonly title: string;
  readonly description?: string;
  readonly input: I;
  // It takes the commits on the run's workspace branch, such as a pull
  // request does.
  readonly commits?: boolean;
}

export type Actions = Readonly<Record<string, ActionDef>>;

// Where a routine's run's result can go when the run ends, such as a Slack
// channel, with what a routine sets for it (ADR 0075).
export interface DestinationDef<S extends TObject = TObject> {
  readonly title: string;
  readonly description?: string;
  readonly settings: S;
}

export type Destinations = Readonly<Record<string, DestinationDef>>;

// A check a routine's trigger can name: a script that sees the event, the
// earlier firings of its piece of work and the trigger's settings, and
// returns true or false (ADR 0075).
export interface CheckDef {
  readonly title: string;
  readonly description?: string;
  readonly script: string;
  readonly settings?: TObject;
}

export type Checks = Readonly<Record<string, CheckDef>>;

export interface PluginDefinition<
  C extends TConfig = TConfig,
  E extends Events = Events,
> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly defaultOn?: "always" | "solo" | "team" | "never";
  // The plugins it can't run without, which start before it.
  readonly requires?: readonly string[];
  // Its Session part keeps the Session's model and MCP logins, through
  // provide.modelCredentials. One plugin per server does.
  readonly modelCredentials?: boolean;
  // Only admins set its key in a template's entry, so a template that follows
  // a repository never takes it from the repository's file.
  readonly adminTemplateKey?: boolean;
  readonly config?: C;
  readonly schema?: string;
  // SQL run in order after schema; never edit schema once released.
  readonly migrations?: readonly string[];
  readonly events?: E;
  readonly actions?: Actions;
  readonly destinations?: Destinations;
  readonly checks?: Checks;
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
  // A group of settings, which forms show under its title.
  object: <P extends TProperties>(
    properties: P,
    o: { readonly title?: string } = {},
  ): TObject<P> =>
    Type.Object(properties, {
      default: {},
      ...(o.title !== undefined && { title: o.title }),
    }),

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
    readonly description?: string;
    readonly default: number;
    readonly min?: number;
    readonly max?: number;
  }): TNumber =>
    Type.Number({
      title: o.title,
      default: o.default,
      ...(o.description !== undefined && { description: o.description }),
      ...(o.min !== undefined && { minimum: o.min }),
      ...(o.max !== undefined && { maximum: o.max }),
    }),

  // A size, which forms show in MB or GB.
  bytes: (o: {
    readonly title: string;
    readonly description?: string;
    readonly default: number;
    readonly min?: number;
  }): TInteger =>
    Type.Integer({
      title: o.title,
      default: o.default,
      minimum: o.min ?? 1,
      ...(o.description !== undefined && { description: o.description }),
      [annotation]: { bytes: true },
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
    // What the collection holds while the file leaves it out.
    readonly default?: readonly Static<I>[];
  }): TCollection<I> =>
    Type.Array(o.item, {
      title: o.title,
      default: o.default ?? [],
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

export function action<I extends TObject>(o: ActionDef<I>): ActionDef<I> {
  return o;
}

export function destination<S extends TObject>(
  o: DestinationDef<S>,
): DestinationDef<S> {
  return o;
}

export function check(o: CheckDef): CheckDef {
  return o;
}

export function event<F extends TObject>(o: {
  readonly title: string;
  readonly description?: string;
  readonly fields: F;
}): EventDef<F> {
  return o;
}
