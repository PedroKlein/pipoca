import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { blobRoutes, type Timer } from "@pipoca/protocol";
import type { TypedClient } from "./client";
import { HttpError } from "./http";
import type { StoredBlob } from "./server";

export const chunkBytes = 8 * 1024 * 1024;

const attempts = 5;
const firstWaitMs = 1000;

// Uploads to the plugin's blob store on the server (ADR 0078), when the
// plugin's server part accepts uploads.
export interface SessionBlobs {
  // The files' SHA-256s the server doesn't have.
  readonly missing: (hashes: readonly string[]) => Promise<readonly string[]>;
  readonly hash: (path: string) => Promise<string>;
  // Sends the file in chunks, carrying on from what the server has, and
  // tries again a few times when the network fails. Throws once it gives up,
  // or at once when the server refuses the file.
  readonly upload: (
    path: string,
    o?: { readonly signal?: AbortSignal },
  ) => Promise<StoredBlob>;
}

export function sessionBlobs(api: TypedClient, timer: Timer): SessionBlobs {
  const missing = async (
    hashes: readonly string[],
  ): Promise<readonly string[]> => {
    const answer = await api.post<{ missing: string[] }>(blobRoutes.missing, {
      hashes,
    });

    return answer.missing;
  };

  const route = (path: string, hash: string): string =>
    path.replace(":id", hash);

  const sent = async (
    hash: string,
    file: string,
    size: number,
    signal: AbortSignal | undefined,
  ): Promise<StoredBlob> => {
    const { received } = await api.get<{ received: number }>(
      route(blobRoutes.upload, hash),
    );

    const handle = await open(file, "r");

    try {
      let offset = received;

      while (offset < size) {
        const chunk = new Uint8Array(Math.min(chunkBytes, size - offset));

        await handle.read(chunk, 0, chunk.length, offset);

        const response = await api.raw(
          `${route(blobRoutes.upload, hash)}?offset=${String(offset)}`,
          {
            method: "PUT",
            body: chunk,
            ...(signal !== undefined && { signal }),
          },
        );

        if (!response.ok) {
          throw await refused(response);
        }

        offset = ((await response.json()) as { received: number }).received;
      }
    } finally {
      await handle.close();
    }

    return api.post<StoredBlob>(route(blobRoutes.finish, hash), { hash });
  };

  const hash = async (path: string): Promise<string> => {
    const digest = createHash("sha256");

    for await (const chunk of createReadStream(path)) {
      digest.update(chunk as Buffer);
    }

    return digest.digest("hex");
  };

  return {
    missing,
    hash,
    upload: async (path, { signal } = {}) => {
      const { size } = await stat(path);
      const digest = await hash(path);

      for (let attempt = 1; ; attempt++) {
        try {
          if ((await missing([digest])).length === 0) {
            return { hash: digest, size };
          }

          return await sent(digest, path, size, signal);
        } catch (error) {
          if (
            attempt === attempts ||
            signal?.aborted === true ||
            !retryable(error)
          ) {
            throw error;
          }

          await waited(timer, firstWaitMs * 2 ** (attempt - 1));
        }
      }
    },
  };
}

async function refused(response: Response): Promise<HttpError> {
  const text = await response.text();
  let message = text;
  let code: string | undefined;

  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };

    message = parsed.message ?? text;
    code = parsed.error;
  } catch {
    // The body wasn't JSON, such as a proxy's error page.
  }

  return new HttpError(response.status, message, code);
}

// A refusal stays one; a lost connection, a 5xx or a moved offset may not.
function retryable(error: unknown): boolean {
  if (!(error instanceof HttpError)) {
    return true;
  }

  return error.status >= 500 || error.status === 409 || error.status === 429;
}

async function waited(timer: Timer, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    timer.after(ms, async () => {
      resolve();

      return Promise.resolve();
    });
  });
}
