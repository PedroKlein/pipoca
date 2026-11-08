import { extname } from "node:path";
import {
  BadRequest,
  HttpError,
  NotFound,
  type PersonCaller,
  type ServerContext,
  type SessionCaller,
  Type,
} from "@pipoca/plugins";
import { type Actor, blobHash } from "@pipoca/protocol";
import type { projects } from "../plugin";
import {
  bytes,
  type FolderFile,
  type FolderSync,
  pathRule,
  validPath,
} from "./model";
import type { Member, Project, projectStore } from "./store";

type Context = ServerContext<typeof projects>;

const dayMs = 24 * 60 * 60 * 1000;
const shownMatches = 20;

const hash = Type.String({ pattern: blobHash.source });
const at = Type.Object({ path: Type.String({ minLength: 1 }) });

const changes = Type.Object({
  changes: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      hash: Type.Union([hash, Type.Null()]),
      base: Type.Union([hash, Type.Null()]),
    }),
    { maxItems: 10_000 },
  ),
});

// A Project's folder, which every Session in the Project sees as project/:
// names and the write log here, bytes in the plugin's blob store (ADR 0078).
export function folderRoutes(
  { blobs, clock, config, log, routes }: Context,
  store: ReturnType<typeof projectStore>,
  {
    theirs,
    memberOf,
  }: {
    readonly theirs: (
      id: string,
      caller: PersonCaller,
      may?: "sees" | "steers",
    ) => Project;
    readonly memberOf: (caller: SessionCaller) => {
      member: Member;
      project: Project;
    };
  },
): void {
  const maxFileBytes = (): number => config.get().maxFileBytes;

  blobs.acceptUploads({ maxBytes: maxFileBytes });

  // The log keeps earlier versions for folderHistoryDays; a blob goes once
  // neither the folder nor the log names it.
  const forgetOld = async (): Promise<void> => {
    const before = clock.now() - config.get().folderHistoryDays * dayMs;

    for (const each of store.forgetWrites(before)) {
      if (!store.hashUsed(each)) {
        await blobs.remove(each);
      }
    }
  };

  const stored = async (path: string, blob: string): Promise<number> => {
    if (!validPath(path)) {
      throw new BadRequest(pathRule);
    }

    const size = await blobs.size(blob);

    if (size === undefined) {
      throw new HttpError(409, `${path} isn't uploaded yet`, "missing");
    }

    if (size > maxFileBytes()) {
      throw new HttpError(
        413,
        `${path} is larger than ${bytes(maxFileBytes())}, the largest file this server keeps`,
        "too_large",
      );
    }

    return size;
  };

  const download = async (blob: string, path: string): Promise<Response> => {
    const stream = await blobs.read(blob);

    if (stream === undefined) {
      throw new NotFound(`no file ${path}`);
    }

    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": attachment(path.split("/").at(-1) ?? path),
      },
    });
  };

  const file = (project: Project, path: string): FolderFile => {
    const found = store.folderFile(project.id, path.normalize("NFC"));

    if (found === undefined) {
      throw new NotFound(`no file ${path}`);
    }

    return found;
  };

  const put = async (
    project: Project,
    path: string,
    blob: string,
    actor: Actor,
  ): Promise<void> => {
    const size = await stored(path, blob);

    store.writeFolder(project.id, {
      path,
      hash: blob,
      size,
      actor,
      conflict: false,
    });

    log("folder file written", { project: project.id, path, actor });
  };

  routes.get(
    "projects/:id/files",
    { auth: "person" },
    ({ caller, params }) => ({
      files: store.folder(theirs(params.id, caller).id),
      perProjectBytes: config.get().perProjectBytes,
    }),
  );

  routes.get("projects/:id/log", { auth: "person" }, ({ caller, params }) => ({
    writes: store.folderWrites(theirs(params.id, caller).id),
  }));

  routes.get(
    "projects/:id/file",
    { auth: "person", query: at },
    async ({ caller, params, query }) => {
      const found = file(theirs(params.id, caller), query.path);

      return download(found.hash, found.path);
    },
  );

  // An earlier version, while the log still has it.
  routes.get(
    "projects/:id/log/:entry",
    { auth: "person" },
    async ({ caller, params }) => {
      const project = theirs(params.id, caller);
      const write = store.folderWrite(project.id, params.entry);

      if (write === undefined || write.hash === null) {
        throw new NotFound(`no version ${params.entry}`);
      }

      return download(write.hash, write.path);
    },
  );

  // A person's upload, sent first with the browser upload routes.
  routes.post(
    "projects/:id/files",
    {
      auth: "person",
      body: Type.Object({ path: Type.String({ minLength: 1 }), hash }),
      changes: ["projects"],
    },
    async ({ caller, params, body }) => {
      const project = theirs(params.id, caller, "steers");
      const path = body.path.normalize("NFC");

      await put(project, path, body.hash, `user:${caller.person.id}`);
      await forgetOld();

      return { path };
    },
  );

  routes.delete(
    "projects/:id/file",
    { auth: "person", query: at, changes: ["projects"] },
    ({ caller, params, query }) => {
      const project = theirs(params.id, caller, "steers");
      const found = file(project, query.path);

      store.writeFolder(project.id, {
        path: found.path,
        hash: null,
        size: 0,
        actor: `user:${caller.person.id}`,
        conflict: false,
      });

      return { removed: found.path };
    },
  );

  routes.get("folder", { auth: "session" }, ({ caller }) => ({
    files: store.folder(memberOf(caller).project.id),
  }));

  routes.get(
    "folder/file",
    { auth: "session", query: at },
    async ({ caller, query }) => {
      const found = file(memberOf(caller).project, query.path);

      return download(found.hash, found.path);
    },
  );

  routes.get(
    "folder/find",
    {
      auth: "session",
      query: Type.Object({ query: Type.String({ maxLength: 200 }) }),
    },
    ({ caller, query }) => {
      const words = query.query.toLowerCase().split(/\s+/).filter(Boolean);

      const matches = store
        .folder(memberOf(caller).project.id)
        .filter(({ path }) =>
          words.every((word) => path.toLowerCase().includes(word)),
        );

      return {
        files: matches.slice(0, shownMatches),
        more: Math.max(0, matches.length - shownMatches),
      };
    },
  );

  // What a Session changed since it last synced. A change made on top of
  // what the folder has now applies; one another Session got to first is
  // kept as "name (from <thread>).ext", and a removal of a file someone
  // since changed is dropped.
  routes.post(
    "folder",
    { auth: "session", body: changes, changes: ["projects"] },
    async ({ caller, body }): Promise<FolderSync> => {
      const { member, project } = memberOf(caller);
      const actor: Actor = `session:${caller.session.id}`;
      const conflicts: { path: string; copy: string }[] = [];

      for (const change of body.changes) {
        const path = change.path.normalize("NFC");
        const current = store.folderFile(project.id, path)?.hash ?? null;

        if (current === change.hash) {
          continue;
        }

        if (change.hash === null) {
          if (current === change.base) {
            store.writeFolder(project.id, {
              path,
              hash: null,
              size: 0,
              actor,
              conflict: false,
            });
          }

          continue;
        }

        if (current === change.base) {
          await put(project, path, change.hash, actor);

          continue;
        }

        const size = await stored(path, change.hash);

        const copy = freeName(
          new Set(store.folder(project.id).map((each) => each.path)),
          path,
          member.title,
        );

        store.writeFolder(project.id, {
          path: copy,
          hash: change.hash,
          size,
          actor,
          conflict: true,
        });

        conflicts.push({ path, copy });
      }

      await forgetOld();

      return { files: store.folder(project.id), conflicts };
    },
  );

  void moveLibrary().catch((error: unknown) => {
    log("library files not moved", { error: String(error) });
  });

  // The library's files from before the folder go into it once.
  async function moveLibrary(): Promise<void> {
    for (
      let old = store.nextLibraryFile();
      old !== undefined;
      old = store.nextLibraryFile()
    ) {
      const blob = await blobs.put(old.content);

      store.writeFolder(old.projectId, {
        path: old.name,
        hash: blob.hash,
        size: blob.size,
        actor: old.actor,
        conflict: false,
      });

      store.dropLibraryFile(old.projectId, old.name);
      log("library file moved", { project: old.projectId, path: old.name });
    }
  }
}

// "notes (from Fix login).md", then "notes (from Fix login) (2).md".
function freeName(
  taken: ReadonlySet<string>,
  path: string,
  thread: string,
): string {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);

  const from = thread
    .replaceAll(/[/\\\p{Cc}\p{Bidi_Control}]/gu, " ")
    .trim()
    .slice(0, 60)
    .trim();

  const named = `${stem} (from ${from === "" ? "another thread" : from})`;
  let candidate = `${named}${ext}`;

  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${named} (${String(n)})${ext}`;
  }

  return candidate;
}

// RFC 8187 leaves ' ( ) and * out of filename*, but encodeURIComponent keeps
// them.
function attachment(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}
