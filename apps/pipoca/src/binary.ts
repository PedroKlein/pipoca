import { join } from "node:path";
import type { Binary } from "@pipoca/runner";
import { version } from "../package.json";
import { installedPart, sessionParts } from "./session-parts";

// A compiled binary is its own entry point. From source, Bun runs main.ts
// with the repository's bunfig.toml, which builds the web UI's styles and
// which Bun only finds by itself in the folder it starts in.
export const pipoca = import.meta.dirname.startsWith("/$bunfs")
  ? [process.execPath]
  : [
      process.execPath,
      `--config=${join(import.meta.dirname, "..", "..", "..", "bunfig.toml")}`,
      join(import.meta.dirname, "main.ts"),
    ];

export const binary: Binary = {
  command: pipoca,
  version,
  parts: async (assignment, installed) =>
    sessionParts(assignment, async (name, hash) =>
      installedPart(name, await installed(name, hash)),
    ),
};
