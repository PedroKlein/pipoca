import type { TypedClient } from "@pipoca/plugins";
import { blobRoutes } from "@pipoca/protocol";

const chunkBytes = 8 * 1024 * 1024;
const attempts = 5;

// Sends a file from the browser in chunks the server hashes, carrying on
// from what it has after a dropped connection, then adds it to the
// Session's uploads. Resolves to its name under uploads/.
export async function uploadFile(
  api: TypedClient,
  sessionId: string,
  file: File,
  onProgress: (sent: number) => void,
): Promise<string> {
  const route = blobRoutes.browserUpload.replace(":id", crypto.randomUUID());
  let offset = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      // An empty file still sends one chunk, which starts the upload.
      do {
        const response = await api.raw(`${route}?offset=${String(offset)}`, {
          method: "PUT",
          body: file.slice(offset, offset + chunkBytes),
        });

        if (!response.ok) {
          throw new Refused(response.status, await message(response));
        }

        offset = ((await response.json()) as { received: number }).received;
        onProgress(offset);
      } while (offset < file.size);

      break;
    } catch (error) {
      if (
        attempt === attempts ||
        (error instanceof Refused && error.status < 500 && error.status !== 409)
      ) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      offset = (await api.get<{ received: number }>(route)).received;
    }
  }

  const { hash } = await api.post<{ hash: string }>(`${route}/finish`, {});

  const { path } = await api.post<{ path: string }>(
    `sessions/${sessionId}/uploads`,
    { name: file.name, hash },
  );

  return path;
}

class Refused extends Error {
  readonly status: number;

  constructor(status: number, text: string) {
    super(text);
    this.status = status;
  }
}

async function message(response: Response): Promise<string> {
  const text = await response.text();

  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}
