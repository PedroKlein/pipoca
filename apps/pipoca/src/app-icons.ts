import { readFileSync } from "node:fs";
import { join } from "node:path";

// The web UI's app icons as base64, by file name. It runs as a macro, so a
// compiled server carries them.
export function appIcons(): Record<string, string> {
  const folder = join(import.meta.dir, "..", "..", "web", "src", "icons");

  return Object.fromEntries(
    ["icon-192.png", "icon-512.png", "maskable-512.png"].map((name) => [
      name,
      readFileSync(join(folder, name)).toString("base64"),
    ]),
  );
}
