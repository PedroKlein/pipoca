import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Type } from "typebox";
import {
  BadRequest,
  type Blobs,
  HttpError,
  type Routes,
  type SessionCaller,
  type StoredBlob,
} from "@pipoca/plugins";
import { blobHash, blobRoutes, uploadId } from "@pipoca/protocol";

// A plugin's bytes in a folder of their own, each file named by its SHA-256
// (ADR 0078). The plugin keeps which hashes it uses and removes the rest.
export function pluginBlobs(dir: string, routes: Routes): Blobs {
  const uploads = join(dir, ".uploads");

  const path = (hash: string): string => {
    if (!blobHash.test(hash)) {
      throw new BadRequest(`${hash} isn't a SHA-256 in hex`);
    }

    return join(dir, hash.slice(0, 2), hash);
  };

  const size = async (hash: string): Promise<number | undefined> =>
    stat(path(hash)).then(
      (found) => found.size,
      () => undefined,
    );

  const place = async (from: string, hash: string): Promise<void> => {
    const to = path(hash);

    await mkdir(join(dir, hash.slice(0, 2)), { recursive: true });
    await rename(from, to);
  };

  const partial = (caller: SessionCaller, id: string): string => {
    if (!uploadId.test(id)) {
      throw new BadRequest(`${id} isn't an upload id`);
    }

    return join(uploads, `${caller.session.id}.${id}`);
  };

  const received = async (file: string): Promise<number> =>
    stat(file).then(
      (found) => found.size,
      () => 0,
    );

  return {
    put: async (bytes) => {
      const hash = createHash("sha256").update(bytes).digest("hex");

      if ((await size(hash)) === undefined) {
        const temp = join(uploads, `put.${randomUUID()}`);

        await mkdir(uploads, { recursive: true });
        await writeFile(temp, bytes);
        await place(temp, hash);
      }

      return { hash, size: bytes.length };
    },
    size,
    read: async (hash) =>
      (await size(hash)) === undefined
        ? undefined
        : (Readable.toWeb(
            createReadStream(path(hash)),
          ) as ReadableStream<Uint8Array>),
    bytes: async (hash) =>
      readFile(path(hash)).then(
        (content) => new Uint8Array(content),
        () => undefined,
      ),
    remove: async (hash) => {
      await rm(path(hash), { force: true });
    },
    acceptUploads: ({ maxBytes }) => {
      routes.post(
        blobRoutes.missing,
        {
          auth: "session",
          body: Type.Object({
            hashes: Type.Array(Type.String(), { maxItems: 1000 }),
          }),
        },
        async ({ body }) => ({
          missing: (
            await Promise.all(
              body.hashes.map(async (hash) =>
                (await size(hash)) === undefined ? [hash] : [],
              ),
            )
          ).flat(),
        }),
      );

      routes.get(
        blobRoutes.upload,
        { auth: "session" },
        async ({ caller, params }) => ({
          received: await received(partial(caller, params.id)),
        }),
      );

      routes.put(
        blobRoutes.upload,
        {
          auth: "session",
          query: Type.Object({ offset: Type.Integer({ minimum: 0 }) }),
        },
        async ({ caller, params, query, raw }) => {
          const file = partial(caller, params.id);
          const have = await received(file);

          if (query.offset !== have) {
            throw new HttpError(
              409,
              `the upload has ${String(have)} bytes, not ${String(query.offset)}`,
              "offset",
            );
          }

          const chunk = new Uint8Array(await raw.arrayBuffer());
          const limit = maxBytes();

          if (have + chunk.length > limit) {
            await rm(file, { force: true });

            throw new HttpError(
              413,
              `files can be up to ${megabytes(limit)} on this server`,
              "too_large",
            );
          }

          await mkdir(uploads, { recursive: true });
          await appendFile(file, chunk);

          return { received: have + chunk.length };
        },
      );

      routes.post(
        blobRoutes.finish,
        { auth: "session", body: Type.Object({ hash: Type.String() }) },
        async ({ caller, params, body }): Promise<StoredBlob> => {
          const file = partial(caller, params.id);
          const content = await readFile(file).catch(() => undefined);

          if (content === undefined) {
            throw new BadRequest(`no upload ${params.id}`);
          }

          const hash = createHash("sha256").update(content).digest("hex");

          if (hash !== body.hash) {
            await rm(file, { force: true });

            throw new HttpError(
              422,
              `the upload's SHA-256 is ${hash}, not ${body.hash}`,
              "hash",
            );
          }

          await place(file, hash);

          return { hash, size: content.length };
        },
      );
    },
  };
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1024 / 1024))} MB`;
}
