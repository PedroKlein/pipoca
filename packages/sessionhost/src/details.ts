import { isObject } from "@pipoca/plugins";
import type { PermissionDetail } from "@pipoca/protocol";

// What the call would change, as labelled values. Ids and empty fields say
// nothing to a person, so they stay out.
export function permissionDetails(
  input: unknown,
  schema: unknown,
): PermissionDetail[] {
  if (!isObject(input)) {
    return input === undefined || input === null
      ? []
      : [{ label: "Input", value: shown(input) }];
  }

  const properties = isObject(schema) ? schema["properties"] : undefined;

  return Object.entries(input)
    .filter(([key, value]) => !isId(key) && !isEmpty(value))
    .map(([key, value]) => ({
      label: titleOf(isObject(properties) ? properties[key] : undefined, key),
      value: shown(value),
    }));
}

function isId(key: string): boolean {
  return key === "id" || key.endsWith("Id");
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  );
}

function titleOf(property: unknown, key: string): string {
  const title = isObject(property) ? property["title"] : undefined;

  return typeof title === "string" && title !== "" ? title : words(key);
}

// setupScript reads as Setup script.
function words(key: string): string {
  const spaced = key
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function shown(value: unknown, indent = ""): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (Array.isArray(value)) {
    return value
      .map((each) => `${indent}• ${shown(each, `${indent}  `).trimStart()}`)
      .join("\n");
  }

  if (isObject(value)) {
    return Object.entries(value)
      .filter(([, each]) => !isEmpty(each))
      .map(([key, each]) => {
        const inner = shown(each, `${indent}  `);

        return inner.includes("\n")
          ? `${indent}${key}:\n${inner}`
          : `${indent}${key}: ${inner.trimStart()}`;
      })
      .join("\n");
  }

  return String(value);
}
