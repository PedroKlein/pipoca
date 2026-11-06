import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routes } from "@pipoca/protocol";

// Paths under /api that the APIRule gives rules of their own.
const ownRules = new Set(["auth", "changes", "sessions", "mcp"]);

const range = /\{\{- range list (?:"[a-z-]+" ?)+\}\}/;

// The APIRule template with one rule for each other path under /api that
// the route table serves, and ext, whose plugin routes are compiled at boot.
export function withApiPaths(template: string): string {
  const paths = new Set([
    "ext",
    ...Object.values(routes).flatMap(({ path }) => {
      const [, api, name = ""] = path.split("/");

      return api === "api" && !ownRules.has(name) ? [name] : [];
    }),
  ]);

  const listed = [...paths]
    .toSorted()
    .map((name) => `"${name}"`)
    .join(" ");

  return template.replace(range, `{{- range list ${listed} }}`);
}

if (import.meta.main) {
  const file = join(
    import.meta.dir,
    "../../../deploy/helm/pipoca/templates/apirule.yaml",
  );

  writeFileSync(file, withApiPaths(readFileSync(file, "utf8")));
}
