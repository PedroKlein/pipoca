import type { Static, TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { HttpError } from "./http";

// The body as the schema types it, without fields the schema doesn't name,
// or a 422 that names the first field that doesn't fit, such as
// "workspace.path must be string" with field "workspace.path".
export function checkBody<const Schema extends TSchema>(
  body: unknown,
  schema: Schema,
): Static<Schema> {
  return checked(body, schema, "body");
}

export function checked<const Schema extends TSchema>(
  value: unknown,
  schema: Schema,
  name: string,
): Static<Schema> {
  if (Value.Check(schema, value)) {
    return Value.Clean(schema, structuredClone(value)) as Static<Schema>;
  }

  const { instancePath, message } = misfit([...Value.Errors(schema, value)]);
  const field = instancePath.slice(1).replaceAll("/", ".");

  throw new HttpError(
    422,
    `${field === "" ? name : field} ${message}`,
    "invalid",
    { field },
  );
}

type Failure = TLocalizedValidationError;

interface Misfit {
  readonly instancePath: string;
  readonly message: string;
}

// The error a person can act on. Inside a union of shapes told apart by a
// field such as kind, that is the error of the shape the body names, or
// which values that field takes.
function misfit(errors: readonly Failure[]): Misfit {
  const unions = errors.filter(({ keyword }) => keyword === "anyOf");

  const plain = errors.find(
    (error) =>
      error.keyword !== "anyOf" &&
      !unions.some((union) => within(error, union)),
  );

  const union = unions.find((each) => !unions.some((u) => within(each, u)));

  if (plain !== undefined || union === undefined) {
    return plain === undefined
      ? unfit(errors[0])
      : { ...plain, message: said(plain) };
  }

  const inside = errors.filter((error) => within(error, union));

  const branchOf = (error: Failure): string =>
    error.schemaPath.slice(union.schemaPath.length).split("/")[2] ?? "";

  const tags = inside.filter(
    (error) =>
      error.keyword === "const" &&
      parentOf(error.instancePath) === union.instancePath,
  );

  const branches = [...new Set(inside.map(branchOf))];

  const meant = branches.filter(
    (branch) => !tags.some((error) => branchOf(error) === branch),
  );

  if (tags.length > 0 && meant.length === 1) {
    return misfit(inside.filter((error) => branchOf(error) === meant[0]));
  }

  const [tag] = tags;
  if (
    tag !== undefined &&
    tags.every(({ instancePath }) => instancePath === tag.instancePath)
  ) {
    return {
      instancePath: tag.instancePath,
      message: `must be one of ${tags.map(allowedValue).join(", ")}`,
    };
  }

  const missing = branches.map((branch) =>
    inside
      .filter(
        (error) =>
          branchOf(error) === branch &&
          error.keyword === "required" &&
          error.instancePath === union.instancePath,
      )
      .flatMap(
        ({ params }) => Reflect.get(params, "requiredProperties") as string[],
      ),
  );

  const common = (missing[0] ?? []).filter((name) =>
    missing.every((names) => names.includes(name)),
  );

  if (common.length > 0) {
    return {
      instancePath: union.instancePath,
      message: `must have required properties ${common.join(", ")}`,
    };
  }

  const types = inside
    .filter(
      ({ keyword, instancePath }) =>
        keyword === "type" && instancePath === union.instancePath,
    )
    .map(({ params }) => String(Reflect.get(params, "type")));

  // Fields a shape doesn't take, for shapes that take only their own.
  const unknown = branches.map((branch) =>
    inside
      .filter(
        (error) =>
          branchOf(error) === branch &&
          error.keyword === "additionalProperties" &&
          error.instancePath === union.instancePath,
      )
      .flatMap(({ params }) => {
        const names: unknown = Reflect.get(params, "additionalProperties");

        return Array.isArray(names) ? (names as unknown[]) : [names];
      }),
  );

  // With no field that tells the shapes apart, the body meant the first
  // shape it misses the fewest fields of and has the fewest fields too many
  // for.
  const distances = branches.map(
    (_, at) => (missing[at]?.length ?? 0) + (unknown[at]?.length ?? 0),
  );

  const closest = branches[distances.indexOf(Math.min(...distances))];

  if (tags.length === 0 && types.length === 0 && closest !== undefined) {
    return misfit(inside.filter((error) => branchOf(error) === closest));
  }

  return {
    instancePath: union.instancePath,
    message:
      types.length > 0
        ? `must be ${types.join(" or ")}`
        : "doesn't fit any of its shapes",
  };
}

function said(error: Failure): string {
  if (error.keyword === "enum") {
    return `must be one of ${error.params.allowedValues.map(String).join(", ")}`;
  }

  return error.message;
}

function unfit(error: Failure | undefined): Misfit {
  return error ?? { instancePath: "", message: "doesn't fit" };
}

function allowedValue(error: Failure): string {
  return String(Reflect.get(error.params, "allowedValue"));
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function within(error: Failure, union: Failure): boolean {
  return error.schemaPath.startsWith(`${union.schemaPath}/anyOf/`);
}
