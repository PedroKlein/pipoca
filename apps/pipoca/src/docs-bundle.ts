import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Decision records, acceptance checklists and planning notes, not
// documentation of what Pipoca does.
const notDocs = new Set([
  "adr",
  "acceptance",
  "research.md",
  "v2-ideas.md",
  "open-questions.md",
]);

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
      .filter((path) => !notDocs.has(path.split("/")[0] ?? ""))
      .map((path) => doc("pipoca", pipoca, path)),
    doc("pi", pi, "README.md"),
    ...markdownIn(piDocs).map((path) => doc("pi", piDocs, path)),
  ]);
}

function doc(
  folder: string,
  dir: string,
  path: string,
): readonly [string, string] {
  return [`${folder}/${path}`, readFileSync(join(dir, path), "utf8")];
}

// Paths relative to dir, with forward slashes, of every Markdown file in it.
function markdownIn(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
}
