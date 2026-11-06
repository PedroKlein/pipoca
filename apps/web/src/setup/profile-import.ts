import { profilePath } from "@pipoca/protocol";
import { base64 } from "../settings/profiles/folder";

// One thing in a picked Pi agent folder that the person can leave out.
interface Item {
  readonly id: string;
  readonly group: Group;
  readonly label: string;
}

export const groups = [
  "Instructions",
  "Skills",
  "Prompts",
  "Extensions",
  "Packages",
  "MCP servers",
] as const;

type Group = (typeof groups)[number];

export interface Picked {
  // Paths inside the agent folder, with the picked folder's name left out.
  readonly files: ReadonlyMap<string, File>;
  readonly items: readonly Item[];
  readonly packages: readonly unknown[];
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
}

function packageName(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }

  const source =
    typeof entry === "object" && entry !== null && "source" in entry
      ? entry.source
      : undefined;

  return typeof source === "string" ? source : JSON.stringify(entry);
}

function itemOf(path: string): Item | undefined {
  if (["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].includes(path)) {
    return { id: "instructions", group: "Instructions", label: "Instructions" };
  }

  const [folder, name] = path.split("/");

  const named = {
    Skills: "skills",
    Prompts: "prompts",
    Extensions: "extensions",
  };

  for (const [group, at] of Object.entries(named)) {
    if (folder === at && name !== undefined) {
      const label = name.replace(/\.(md|ts|js)$/, "");

      return { id: `${at}/${label}`, group: group as Group, label };
    }
  }

  return undefined;
}

async function jsonFile(
  file: File | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (file === undefined) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(await file.text());

    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function pickedOf(chosen: readonly File[]): Promise<Picked> {
  const files = new Map(
    chosen
      .map((file) => {
        const path = file.webkitRelativePath.split("/").slice(1).join("/");

        return [path, file] as const;
      })
      .filter(([path]) => profilePath(path)),
  );

  const items = new Map<string, Item>();

  for (const path of files.keys()) {
    const item = itemOf(path);

    if (item !== undefined) {
      items.set(item.id, item);
    }
  }

  const { packages, ...settings } = await jsonFile(files.get("settings.json"));
  const listed = Array.isArray(packages) ? (packages as unknown[]) : [];

  for (const entry of listed) {
    const name = packageName(entry);

    items.set(`package/${name}`, {
      id: `package/${name}`,
      group: "Packages",
      label: name,
    });
  }

  const mcp = (await jsonFile(files.get("mcp.json")))["mcpServers"];

  const mcpServers =
    typeof mcp === "object" && mcp !== null
      ? (mcp as Record<string, unknown>)
      : {};

  for (const name of Object.keys(mcpServers)) {
    items.set(`mcp/${name}`, {
      id: `mcp/${name}`,
      group: "MCP servers",
      label: name,
    });
  }

  return {
    files,
    items: [...items.values()],
    packages: listed,
    mcpServers,
    settings,
  };
}

// The picked folder's files without what the person left out, with
// settings.json and mcp.json rewritten to match.
export async function filesToImport(
  picked: Picked,
  left: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  const encode = (text: string): string =>
    base64(new TextEncoder().encode(text));

  for (const [path, file] of picked.files) {
    const item = itemOf(path);

    if (
      path === "settings.json" ||
      path === "mcp.json" ||
      (item !== undefined && left.has(item.id))
    ) {
      continue;
    }

    files[path] = base64(new Uint8Array(await file.arrayBuffer()));
  }

  const packages = picked.packages.filter(
    (entry) => !left.has(`package/${packageName(entry)}`),
  );

  if (picked.files.has("settings.json")) {
    files["settings.json"] = encode(
      JSON.stringify({ ...picked.settings, packages }, null, 2),
    );
  }

  const mcpServers = Object.fromEntries(
    Object.entries(picked.mcpServers).filter(
      ([name]) => !left.has(`mcp/${name}`),
    ),
  );

  if (Object.keys(mcpServers).length > 0) {
    files["mcp.json"] = encode(JSON.stringify({ mcpServers }, null, 2));
  }

  return files;
}
