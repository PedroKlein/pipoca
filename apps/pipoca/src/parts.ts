import { existsSync } from "node:fs";
import { join } from "node:path";

// A defined plugin's parts are these files, when it has them, each with a
// named export of the part's name.
const paths = {
  server: "src/server.ts",
  session: "src/session.ts",
  web: "web/index.tsx",
} as const;

export type Part = keyof typeof paths;

export function definedParts(
  folder: string,
): Readonly<Partial<Record<Part, string>>> {
  return Object.fromEntries(
    Object.entries(paths).flatMap(([part, path]) =>
      existsSync(join(folder, path)) ? [[part, join(folder, path)]] : [],
    ),
  );
}
