import {
  type Environment,
  type EnvironmentTemplate,
  kindOf,
} from "@pipoca/protocol";
import type { ConfirmOptions, KeyValue } from "@pipoca/ui";
import { api } from "../../api";

// Whether the person went ahead. The server refuses while any of its
// Sessions isn't archived.
export async function deleteEnvironment(
  environment: Environment,
  ask: (options: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  if (
    !(await ask({
      title: `Delete ${environment.name}?`,
      description:
        "Its runners stop working, and its archived Sessions go with it.",
      confirm: "Delete",
      danger: true,
    }))
  ) {
    return false;
  }

  await api("environments.remove", { params: { id: environment.id } });

  return true;
}

export function rowsOf(environment: Environment): readonly KeyValue[] {
  return [
    ...Object.entries(environment.variables).map(([name, value]) => ({
      name,
      value,
      secret: false,
    })),
    ...environment.secrets.map((name) => ({
      name,
      value: "",
      secret: true,
      saved: true,
    })),
  ];
}

// The variables when they changed, and the secrets to set or, as null, to
// remove. A saved secret left empty keeps its value.
export function changedValues(
  environment: Environment,
  rows: readonly KeyValue[],
): {
  readonly variables: Record<string, string> | undefined;
  readonly secrets: Record<string, string | null>;
} {
  const named = rows.filter(({ name }) => name.trim() !== "");
  const names = named.map(({ name }) => name.trim());
  const twice = names.find((name, index) => names.indexOf(name) !== index);

  if (twice !== undefined) {
    throw new Error(`${twice} is set twice.`);
  }

  const variables = Object.fromEntries(
    named
      .filter(({ secret }) => !secret)
      .map(({ name, value }) => [name.trim(), value]),
  );

  const secrets = {
    ...Object.fromEntries(
      environment.secrets
        .filter((name) => !named.some((row) => row.secret && row.name === name))
        .map((name) => [name, null]),
    ),
    ...Object.fromEntries(
      named
        .filter(({ secret, value }) => secret && value !== "")
        .map(({ name, value }) => [name.trim(), value]),
    ),
  };

  return {
    variables:
      JSON.stringify(variables) === JSON.stringify(environment.variables)
        ? undefined
        : variables,
    secrets,
  };
}

// A template sets the other fields, so the form has only the name then.
export function fieldsOf(
  environment: Environment,
  template: EnvironmentTemplate | undefined,
): Record<string, string> {
  return {
    name: environment.name,
    ...(template === undefined && {
      ...(kindOf(environment) !== "kubernetes" && {
        isolation: environment.isolation,
      }),
      image: environment.image ?? "",
      setupScript: environment.setupScript,
    }),
  };
}
