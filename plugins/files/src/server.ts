import { extname } from "node:path";
import {
  BadRequest,
  defineServer,
  HttpError,
  NotFound,
  Type,
} from "@pipoca/plugins";
import { blobHash } from "@pipoca/protocol";
import { files } from "../plugin";
import {
  bytes,
  cleanPath,
  type Place,
  type SessionFile,
  uploadNotice,
  type UploadNoticeData,
} from "./files";

interface Row {
  readonly place: Place;
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly saved_at: number;
  readonly added_by: string | null;
}

const columns = "place, path, hash, size, saved_at, added_by";

const listed = (row: Row): SessionFile => ({
  place: row.place,
  path: row.path,
  hash: row.hash,
  size: row.size,
  savedAt: row.saved_at,
  by: row.added_by,
});

const found = Type.Object({ query: Type.String({ maxLength: 200 }) });

const outputs = Type.Object({
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      hash: Type.String({ pattern: blobHash.source }),
      size: Type.Integer({ minimum: 0 }),
    }),
    { maxItems: 10_000 },
  ),
});

const shownMatches = 20;

// Session outputs and uploads, their bytes in the plugin's blob store and
// their names here (ADR 0078).
export const server = defineServer(
  files,
  ({ blobs, clock, config, routes, sessions, store }) => {
    const maxFileBytes = (): number => config.get().maxFileBytes;

    blobs.acceptUploads({ maxBytes: maxFileBytes });

    const of = (sessionId: string, place?: Place): readonly SessionFile[] =>
      store
        .all<Row>(
          `select ${columns} from files_session_files
           where session_id = ? and (?2 is null or place = ?2)
           order by place, path`,
          sessionId,
          place ?? null,
        )
        .map(listed);

    const seen = (sessionId: string, person: string, act = false): void => {
      const allowed = act
        ? sessions.steers(sessionId, person)
        : sessions.sees(sessionId, person);

      if (!allowed) {
        throw new NotFound(`no Session ${sessionId}`);
      }
    };

    // A blob goes once no Session's file names it.
    const dropUnused = async (hashes: readonly string[]): Promise<void> => {
      for (const hash of new Set(hashes)) {
        const used = store.get<{ one: number }>(
          "select 1 as one from files_session_files where hash = ? limit 1",
          hash,
        );

        if (used === undefined) {
          await blobs.remove(hash);
        }
      }
    };

    const download = async (
      sessionId: string,
      place: Place,
      path: string,
    ): Promise<Response> => {
      const row = store.get<Row>(
        `select ${columns} from files_session_files
         where session_id = ? and place = ? and path = ?`,
        sessionId,
        place,
        path,
      );

      const stream = row && (await blobs.read(row.hash));

      if (row === undefined || stream === undefined) {
        throw new NotFound(`no file ${place}/${path}`);
      }

      return new Response(stream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(row.size),
          "content-disposition": attachment(path.split("/").at(-1) ?? path),
        },
      });
    };

    routes.get("limits", { auth: "person" }, () => ({
      maxFileBytes: maxFileBytes(),
    }));

    routes.get(
      "sessions/:id/files",
      { auth: "person" },
      ({ caller, params }) => {
        seen(params.id, caller.person.id);

        return { files: of(params.id) };
      },
    );

    routes.get(
      "sessions/:id/files/:place",
      {
        auth: "person",
        query: Type.Object({ path: Type.String({ minLength: 1 }) }),
      },
      async ({ caller, params, query }) => {
        seen(params.id, caller.person.id);

        return download(params.id, placeOf(params.place), query.path);
      },
    );

    routes.post(
      "sessions/:id/uploads",
      {
        auth: "person",
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 255 }),
          hash: Type.String({ pattern: blobHash.source }),
        }),
        changes: ["files"],
      },
      async ({ caller, params, body }) => {
        seen(params.id, caller.person.id, true);
        const size = await blobs.size(body.hash);

        if (size === undefined) {
          throw new BadRequest(`no uploaded file ${body.hash}`);
        }

        const path = freeName(
          new Set(of(params.id, "uploads").map((file) => file.path)),
          baseName(body.name),
        );

        store.run(
          `insert into files_session_files
             (session_id, place, path, hash, size, added_by, saved_at)
           values (?, 'uploads', ?, ?, ?, ?, ?)`,
          params.id,
          path,
          body.hash,
          size,
          caller.person.id,
          clock.now(),
        );

        const data: UploadNoticeData = { path, size };

        sessions.send(params.id, {
          text: `${caller.person.name} added uploads/${path} (${bytes(size)}) to the workspace.`,
          turn: false,
          as: `user:${caller.person.id}`,
          notice: { kind: uploadNotice, data },
          dedupe: `upload:${path}`,
        });

        return { path };
      },
    );

    routes.get("session/uploads", { auth: "session" }, ({ caller }) => ({
      files: of(caller.session.id, "uploads"),
    }));

    routes.get(
      "session/files/:place",
      {
        auth: "session",
        query: Type.Object({ path: Type.String({ minLength: 1 }) }),
      },
      async ({ caller, params, query }) =>
        download(caller.session.id, placeOf(params.place), query.path),
    );

    routes.get(
      "session/files",
      { auth: "session", query: found },
      ({ caller, query }) => {
        const words = query.query.toLowerCase().split(/\s+/).filter(Boolean);

        const matches = of(caller.session.id).filter(({ place, path }) =>
          words.every((word) =>
            `${place}/${path}`.toLowerCase().includes(word),
          ),
        );

        return {
          files: matches.slice(0, shownMatches),
          more: Math.max(0, matches.length - shownMatches),
        };
      },
    );

    // The Session's whole outputs/ folder as it is now: files it no longer
    // has go, and every hash must already be stored.
    routes.put(
      "session/outputs",
      { auth: "session", body: outputs, changes: ["files"] },
      async ({ caller, body }) => {
        const sessionId = caller.session.id;
        const limit = maxFileBytes();

        for (const file of body.files) {
          if (cleanPath(file.path) === undefined) {
            throw new BadRequest(`${file.path} isn't a path under outputs/`);
          }

          if (file.size > limit) {
            throw new HttpError(
              413,
              `${file.path} is larger than ${bytes(limit)}, the largest file this server keeps`,
              "too_large",
            );
          }
        }

        const absent = (
          await Promise.all(
            body.files.map(async ({ hash }) =>
              (await blobs.size(hash)) === undefined ? [hash] : [],
            ),
          )
        ).flat();

        if (absent.length > 0) {
          throw new HttpError(
            409,
            `${String(absent.length)} of the files aren't uploaded yet`,
            "missing",
          );
        }

        const before = of(sessionId, "outputs");
        const now = clock.now();

        store.transaction(() => {
          store.run(
            "delete from files_session_files where session_id = ? and place = 'outputs'",
            sessionId,
          );

          for (const file of body.files) {
            const kept = before.find(
              ({ path, hash }) => path === file.path && hash === file.hash,
            );

            store.run(
              `insert into files_session_files
                 (session_id, place, path, hash, size, added_by, saved_at)
               values (?, 'outputs', ?, ?, ?, null, ?)`,
              sessionId,
              file.path,
              file.hash,
              file.size,
              kept?.savedAt ?? now,
            );
          }
        });

        await dropUnused(before.map(({ hash }) => hash));

        return { saved: body.files.length };
      },
    );
  },
);

function placeOf(place: string): Place {
  if (place !== "outputs" && place !== "uploads") {
    throw new NotFound(`no place ${place}`);
  }

  return place;
}

function baseName(name: string): string {
  const base = name.split(/[/\\]/).at(-1)?.replaceAll("\0", "") ?? "";

  return base === "" || base === "." || base === ".." ? "file" : base;
}

// "notes.txt", then "notes (2).txt", as a browser names a second download.
function freeName(taken: ReadonlySet<string>, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;

  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${stem} (${String(n)})${ext}`;
  }

  return candidate;
}

function attachment(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}
