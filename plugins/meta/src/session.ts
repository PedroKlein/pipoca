import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  isObject,
  type SessionCloud,
  type SessionPlugin,
} from "@pipoca/plugins";
import type { PermissionDetail } from "@pipoca/protocol";
import { installTools } from "./install";

// tool_search only loads tools, but carries no hints.
const readers = new Set(["tool_search"]);

// A meta-session asks the user before a destructive call and runs the rest
// straight away (ADR 0035). A tool without hints counts as destructive. The
// user can let one tool run for the rest of the Session.
export const metaSession: SessionPlugin = {
  name: "meta",
  ownSessionsOnly: true,
  tools: installTools,
  extension: (cloud) => (pi) => {
    const allowed = new Set<string>();

    pi.on("tool_call", async (event, ctx) => {
      const tool = toolOf(pi, event.toolName);

      if (
        !destructive(event.toolName, tool, event.input) ||
        allowed.has(event.toolName)
      ) {
        return undefined;
      }

      const answer = await cloud.askPermission(
        await question(cloud, event.toolName, event.input),
        details(event.input, tool?.parameters),
        ctx.signal,
      );

      if (answer === "session") {
        allowed.add(event.toolName);
      }

      return answer === "deny"
        ? { block: true, reason: `The user didn't allow ${event.toolName}.` }
        : undefined;
    });
  },
};

function toolOf(pi: ExtensionAPI, name: string): ToolInfo | undefined {
  return pi.getAllTools().find((tool) => tool.name === name);
}

// A new Profile is the person's own, so making one asks nothing; writing
// into one they have does.
function destructive(
  name: string,
  tool: ToolInfo | undefined,
  input: unknown,
): boolean {
  const hints = tool?.annotations;

  return !(
    readers.has(name) ||
    (name === "install_profile" &&
      isObject(input) &&
      input["id"] === undefined) ||
    hints?.readOnlyHint === true ||
    hints?.destructiveHint === false
  );
}

// A toolset tool's own question names what it changes. Any other tool gets a
// plain one.
async function question(
  cloud: SessionCloud,
  name: string,
  input: unknown,
): Promise<string> {
  const own = ownQuestion(name, input);

  if (own !== undefined) {
    return own;
  }

  try {
    const response = await cloud.request("asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: name, input }),
    });

    const { text } = (await response.json()) as { text: unknown };

    if (response.ok && typeof text === "string" && text !== "") {
      return text;
    }
  } catch (error) {
    cloud.log("no question for the tool call", {
      tool: name,
      error: String(error),
    });
  }

  return `Let the assistant run “${name.replaceAll("_", " ")}”?`;
}

function ownQuestion(name: string, input: unknown): string | undefined {
  const field = (key: string): string =>
    isObject(input) && typeof input[key] === "string" ? input[key] : "";

  if (name === "install_profile") {
    return `Write the files of ${field("path")} into the Profile ${field("id")}?`;
  }

  if (name === "install_plugin") {
    return `Install the plugin “${field("plugin")}” from ${field("path")}? It stays off until an admin turns it on.`;
  }

  return undefined;
}

// What the call would change, as labelled values. Ids and empty fields say
// nothing to a person, so they stay out.
function details(input: unknown, schema: unknown): PermissionDetail[] {
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
