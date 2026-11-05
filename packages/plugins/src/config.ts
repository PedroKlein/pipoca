import type { Log } from "@pipoca/protocol";
import { type Static, type TObject, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { checked } from "./body";
import { annotation } from "./definition";
import { isObject } from "./http";
import type { PluginConfig } from "./plugin";
import type { SecretRef, SecretRefs } from "./secrets";

export type ConfigSecrets = Pick<SecretRefs, "open">;

const slug = /^[a-z0-9][a-z0-9-]*$/;

export function configOf<const S extends TSchema>(
  schema: S,
  raw: unknown,
  secrets: ConfigSecrets,
  log: Log,
): Static<S> {
  const filled = Value.Default(schema, structuredClone(raw));
  const kept = checked(pruned(schema, filled, [], log), schema, "config");

  return opened(schema, kept, [], secrets, log) as Static<S>;
}

// Plain secrets in a change, such as one typed in Settings, sealed with the
// context they are opened with.
export function sealedConfig(
  schema: TSchema,
  value: unknown,
  seal: (secret: string, context: string) => SecretRef,
): unknown {
  return secretsMapped(schema, value, [], (field, context) =>
    typeof field === "string" ? seal(field, context) : field,
  );
}

const unopened: ConfigSecrets = {
  open: () => ({ ref: { env: "" }, secret: "" }),
};

// What a Session part reads: the config with its defaults, without secrets.
export function sessionConfig(
  schema: TSchema,
  raw: unknown,
  log: Log,
): unknown {
  return secretsMapped(
    schema,
    configOf(schema, raw, unopened, log),
    [],
    () => dropped,
  );
}

const dropped = Symbol("dropped");

function secretsMapped(
  schema: TSchema,
  value: unknown,
  path: readonly string[],
  map: (secret: unknown, context: string) => unknown,
): unknown {
  if (marks(schema)["secret"] !== undefined) {
    return map(value, path.join("."));
  }

  if (Type.IsArray(schema) && Array.isArray(value)) {
    return value.map((item: unknown) =>
      secretsMapped(schema.items, item, path, map),
    );
  }

  if (Type.IsObject(schema) && isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, field]) => {
        const property = propertyOf(schema, name);

        const mapped =
          property === undefined
            ? field
            : secretsMapped(property, field, [...path, name], map);

        return mapped === dropped ? [] : [[name, mapped]];
      }),
    );
  }

  return value;
}

const noSecrets: ConfigSecrets = {
  open: (_value, _context, field) => {
    throw new Error(`${field}: the kernel's keys hold no secrets`);
  },
};

// A field or entry that doesn't fit is logged once and takes its default,
// and the others keep their values.
export function kernelConfig<const S extends TSchema>(
  config: PluginConfig,
  schema: S,
  log: Log,
): () => Static<S> {
  let last: { readonly raw: unknown; readonly value: Static<S> } | undefined;

  const read = (raw: unknown): Static<S> => {
    try {
      return configOf(schema, fitting(schema, raw, log), noSecrets, log);
    } catch (error) {
      log("config unreadable", { error: messageOf(error) });

      return configOf(schema, undefined, noSecrets, log);
    }
  };

  return () => {
    const raw = config.get();

    if (last === undefined || last.raw !== raw) {
      last = { raw, value: read(raw) };
    }

    return last.value;
  };
}

function fitting(schema: TSchema, raw: unknown, log: Log): unknown {
  if (!isObject(raw)) {
    return raw;
  }

  const fieldOf = (name: string): TSchema | undefined => {
    if (Type.IsRecord(schema)) {
      return Type.RecordValue(schema);
    }

    return Type.IsObject(schema) ? propertyOf(schema, name) : undefined;
  };

  return Object.fromEntries(
    Object.entries(raw).filter(([name, value]) => {
      const field = fieldOf(name);

      if (field === undefined) {
        return true;
      }

      try {
        checked(Value.Default(field, structuredClone(value)), field, name);

        return true;
      } catch (error) {
        log("config field skipped", { field: name, error: messageOf(error) });

        return false;
      }
    }),
  );
}

function pruned(
  schema: TSchema,
  value: unknown,
  path: readonly string[],
  log: Log,
): unknown {
  const key = collectionKey(schema);

  if (key !== undefined && Type.IsArray(schema) && Array.isArray(value)) {
    const seen = new Set<string>();

    return value.filter((item: unknown, at) => {
      const name = isObject(item) ? item[key] : undefined;
      const problem = itemProblem(schema.items, item, key, name, seen);

      if (problem !== undefined) {
        skipped(log, path, typeof name === "string" ? name : at, problem);

        return false;
      }

      seen.add(name as string);

      return true;
    });
  }

  if (Type.IsObject(schema) && isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => {
        const property = propertyOf(schema, name);

        return [
          name,
          property === undefined
            ? field
            : pruned(property, field, [...path, name], log),
        ];
      }),
    );
  }

  return value;
}

function itemProblem(
  schema: TSchema,
  item: unknown,
  key: string,
  name: unknown,
  seen: ReadonlySet<string>,
): string | undefined {
  try {
    checked(item, schema, "item");
  } catch (error) {
    return messageOf(error);
  }

  if (typeof name !== "string" || !slug.test(name)) {
    return `${key} must be lowercase letters, digits and hyphens`;
  }

  return seen.has(name) ? `another item has the ${key} ${name}` : undefined;
}

function opened(
  schema: TSchema,
  value: unknown,
  path: readonly string[],
  secrets: ConfigSecrets,
  log: Log,
): unknown {
  if (marks(schema)["secret"] !== undefined) {
    const context = path.join(".");

    return secrets.open(value, context, context).secret;
  }

  const key = collectionKey(schema);

  if (key !== undefined && Type.IsArray(schema) && Array.isArray(value)) {
    return value.flatMap((item: unknown) => {
      try {
        return [opened(schema.items, item, path, secrets, log)];
      } catch (error) {
        const name = isObject(item) ? String(item[key]) : "";

        skipped(log, path, name, messageOf(error));

        return [];
      }
    });
  }

  if (Type.IsObject(schema) && isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => {
        const property = propertyOf(schema, name);

        return [
          name,
          property === undefined
            ? field
            : opened(property, field, [...path, name], secrets, log),
        ];
      }),
    );
  }

  return value;
}

function skipped(
  log: Log,
  path: readonly string[],
  item: string | number,
  error: string,
): void {
  log("config item skipped", { path: path.join("."), item, error });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function propertyOf(schema: TObject, name: string): TSchema | undefined {
  return Object.hasOwn(schema.properties, name)
    ? schema.properties[name]
    : undefined;
}

function marks(schema: TSchema): Readonly<Record<string, unknown>> {
  const found: unknown = Reflect.get(schema, annotation);

  return isObject(found) ? found : {};
}

function collectionKey(schema: TSchema): string | undefined {
  const collection = marks(schema)["collection"];

  return isObject(collection) && typeof collection["key"] === "string"
    ? collection["key"]
    : undefined;
}
