import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Planning notes, not documentation of what Pipoca does.
const planning = new Set(["research.md", "v2-ideas.md", "open-questions.md"]);

// Pipoca's and Pi's docs by their path in a Session's docs folder (ADR 0052).
// It runs as a macro, so a compiled server carries them.
export function bundledDocs(): Record<string, string> {
  const pipoca = join(import.meta.dir, "..", "..", "..", "docs");

  const pi = dirname(
    dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
  );

  const piDocs = join(pi, "docs");

  return Object.fromEntries([
    ...markdownIn(pipoca)
      .filter((name) => !planning.has(name))
      .map((name) => doc("pipoca", pipoca, name)),
    doc("pi", pi, "README.md"),
    ...markdownIn(piDocs).map((name) => doc("pi", piDocs, name)),
  ]);
}

function doc(
  folder: string,
  dir: string,
  name: string,
): readonly [string, string] {
  return [`${folder}/${name}`, readFileSync(join(dir, name), "utf8")];
}

function markdownIn(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".md"));
}
