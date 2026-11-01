import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { encoded } from "@pipoca/profiles";
import type { ProfileFiles } from "@pipoca/protocol";
import { bundledDocs } from "./docs-bundle" with { type: "macro" };

// The docs every Session gets as files (ADR 0052): Pipoca's, Pi's and each
// running installed plugin's own docs folder, by plugin id.
export function sessionDocs(
  plugins: readonly { readonly id: string; readonly folder: string }[],
): ProfileFiles {
  const files = new Map(
    Object.entries(bundledDocs()).map(
      ([path, content]) => [path, Buffer.from(content)] as const,
    ),
  );

  for (const { id, folder } of plugins) {
    const docs = join(folder, "docs");

    if (!existsSync(docs)) {
      continue;
    }

    // Links are left out, so a plugin can't hand Sessions a file from
    // elsewhere on the server.
    for (const entry of readdirSync(docs, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const path = join(entry.parentPath, entry.name);

        files.set(
          `plugins/${id}/${relative(docs, path).split(sep).join("/")}`,
          readFileSync(path),
        );
      }
    }
  }

  return encoded(files);
}
