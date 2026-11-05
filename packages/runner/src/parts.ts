import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionStart } from "@pipoca/protocol";
import { fetchSessionPart } from "./client";

// Gives the file of an installed plugin's Session part, fetching its bundle
// into the Session's folder the first time, so a reload doesn't fetch it
// again.
export function installedParts(
  server: string,
  assignment: SessionStart,
  sessionDir: string,
): (name: string, hash: string) => Promise<string> {
  const dir = join(sessionDir, "plugin-parts");

  return async (name, hash) => {
    const path = join(dir, `${name}-${hash}.js`);

    if (await exists(path)) {
      return path;
    }

    const code = await fetchSessionPart(server, assignment, name, hash);
    const got = new Bun.CryptoHasher("sha256").update(code).digest("hex");

    if (got !== hash) {
      throw new Error(`the ${name} plugin's Session part changed on the way`);
    }

    // Two starts of one Session can fetch it at once.
    await writeWhole(path, code);

    return path;
  };
}

// A reader, or another writer, never sees the file half written.
export async function writeWhole(
  path: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const partial = `${path}.${randomUUID()}`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(partial, content, mode === undefined ? {} : { mode });
  await rename(partial, path);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
