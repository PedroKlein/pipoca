interface Schema {
  readonly type?: unknown;
  readonly enum?: unknown;
  readonly const?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly items?: unknown;
}

// Models sometimes send a value JSON-encoded, such as "\"done\"" for an enum
// or "[\"a\"]" for an array, and Pi's validator only turns strings into
// numbers and booleans (ADR 0038).
export function repairArguments(
  args: unknown,
  schema: Readonly<Record<string, unknown>>,
): unknown {
  const properties = propertiesOf(schema);
  const given = withoutEmptyFields(args, schema);
  if (!isRecord(given) || properties === undefined) {
    return given;
  }

  let repaired: Record<string, unknown> | undefined;

  for (const [name, property] of Object.entries(properties)) {
    const value = given[name];
    if (typeof value !== "string" || fits(value, property)) {
      continue;
    }

    const parsed = parseJson(value);
    if (parsed !== undefined && fits(parsed, property)) {
      repaired ??= { ...given };
      repaired[name] = parsed;
    }
  }

  const result = repaired ?? given;
  refuseUnknownChoices(result, properties);

  return result;
}

// Some models fill every optional field, with "" or null when they have no
// value, and a tool then refuses the empty value or takes it as meant.
function withoutEmptyFields(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && isRecord(schema.items)) {
    const items: Schema = schema.items;

    return value.map((item) => withoutEmptyFields(item, items));
  }

  const properties = isRecord(value) ? propertiesOf(schema) : undefined;

  if (!isRecord(value) || properties === undefined) {
    return value;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];

  return Object.fromEntries(
    Object.entries(value).flatMap(([name, field]) => {
      if ((field === "" || field === null) && !required.includes(name)) {
        return [];
      }

      const property = properties[name];

      return [
        [
          name,
          property === undefined ? field : withoutEmptyFields(field, property),
        ],
      ];
    }),
  );
}

// Pi's own message for a wrong enum doesn't say what is allowed, so a model
// tends to send the same value again.
function refuseUnknownChoices(
  args: Record<string, unknown>,
  properties: Readonly<Record<string, Schema>>,
): void {
  for (const [name, property] of Object.entries(properties)) {
    const choices = property.enum;
    const value = args[name];

    if (
      Array.isArray(choices) &&
      value !== undefined &&
      !choices.includes(value)
    ) {
      throw new Error(
        `${name} must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}, not ${JSON.stringify(value)}`,
      );
    }
  }
}

function fits(value: unknown, schema: Schema): boolean {
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value);
  }

  if ("const" in schema) {
    return schema.const === value;
  }

  const members = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(members)) {
    return members.some((member) => isRecord(member) && fits(value, member));
  }

  const types = [schema.type].flat().filter((type) => type !== undefined);

  return types.length === 0 || types.some((type) => hasType(value, type));
}

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function propertiesOf(
  schema: Readonly<Record<string, unknown>> | Schema,
): Readonly<Record<string, Schema>> | undefined {
  const { properties } = schema as Schema;

  return isRecord(properties)
    ? (properties as Readonly<Record<string, Schema>>)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
