import type { ApiReply } from "@pipoca/protocol";

export type ConfigList = ApiReply<"settings.config">;

type ConfigEntry = ConfigList["files"][number];

type TreeItem =
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly depth: number;
    }
  | {
      readonly kind: "file";
      readonly entry: ConfigEntry;
      readonly label: string;
      readonly depth: number;
    };

// Files come sorted, so a folder's heading goes before its first file. A
// file outside the folder, such as the locked one, keeps its whole path.
export function treeOf(files: readonly ConfigEntry[]): readonly TreeItem[] {
  const shown = new Set<string>();

  return files.flatMap((entry): TreeItem[] => {
    if (entry.name.startsWith("/")) {
      return [{ kind: "file", entry, label: entry.name, depth: 0 }];
    }

    const parts = entry.name.split("/");

    const folders = parts.slice(0, -1).flatMap((name, depth): TreeItem[] => {
      const path = parts.slice(0, depth + 1).join("/");

      if (shown.has(path)) {
        return [];
      }

      shown.add(path);

      return [{ kind: "folder", name, path, depth }];
    });

    return [
      ...folders,
      {
        kind: "file",
        entry,
        label: parts.at(-1) ?? entry.name,
        depth: parts.length - 1,
      },
    ];
  });
}

// Folders start closed, so only a file whose folders are all open shows.
export function shownOf(
  items: readonly TreeItem[],
  open: ReadonlySet<string>,
): readonly TreeItem[] {
  return items.filter((item) => {
    const name = item.kind === "folder" ? item.path : item.entry.name;

    if (name.startsWith("/")) {
      return true;
    }

    const parts = name.split("/");

    return parts
      .slice(0, -1)
      .every((_, depth) => open.has(parts.slice(0, depth + 1).join("/")));
  });
}

export function toggled(
  open: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(open);

  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }

  return next;
}

export function jsonError(
  text: string,
  keyPerPlugin: boolean,
): string | undefined {
  try {
    const value: unknown = JSON.parse(text);

    return !keyPerPlugin ||
      (typeof value === "object" && value !== null && !Array.isArray(value))
      ? undefined
      : "It must hold an object with a key per plugin.";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A file written by hand or by a tool can be on one line.
export function pretty(text: string): string {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
}
