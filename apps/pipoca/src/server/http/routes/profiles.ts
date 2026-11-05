import {
  BadRequest,
  checkBody,
  HttpError,
  NotFound,
  readJson,
  Type,
} from "@pipoca/plugins";
import { repositoryImport } from "@pipoca/protocol";
import type { Layer, Profiles } from "@pipoca/profiles";
import type { ApiDeps, Group } from "../deps";
import type { Handlers } from "../router";

const rejections = {
  not_found: [404, "There is no such Profile."],
  default: [409, "The default Profile can't be removed."],
  in_use: [409, "Sessions still use this Profile."],
  admin_only: [403, "Only admins change shared Profiles."],
  team: [400, "Only team work runs on a team Profile."],
  synced: [
    409,
    "This Profile follows its repository. Make a copy to change it.",
  ],
} as const;

type Rejection = keyof typeof rejections;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

function ok<T>(result: Result<T>): T {
  if (!result.ok) {
    const [status, message] = rejections[result.reason];

    throw new HttpError(status, message, result.reason);
  }

  return result.value;
}

// A Profile comes from an exported file, from a repository's root, or from
// the folders its pipoca.json lists.
const importSource = Type.Partial(repositoryImport);

// Shared Profiles are changed only by admins (ADR 0041).
export function profileRoutes({
  profiles,
  log,
}: ApiDeps): Handlers<Group<"profiles"> | Group<"layers">> {
  return {
    "profiles.list": ({ query, caller }) =>
      profiles.list(caller.id, { team: query.owner === "team" }),
    "profiles.create": ({ body, caller }) => {
      const created = ok(profiles.create(caller.id, body, caller.admin));
      log("profile created", { profileId: created.id });

      return created;
    },
    // A gzip body is an exported archive. A JSON body with a url imports
    // from a git repository, and any other is an exported Profile file.
    "profiles.import": async ({ request, query, caller }) => {
      if (request.headers.get("content-type") === "application/gzip") {
        const name = query.name ?? "";

        const imported = await profiles.importArchive(
          caller.id,
          name.trim() === "" ? "Imported" : name,
          await request.bytes(),
        );

        log("profile imported", { profileId: imported.id });

        return imported;
      }

      const body = await readJson(request);
      const { url, paths } = checkBody(body, importSource);

      if (paths !== undefined) {
        if (url === undefined) {
          throw new BadRequest("paths must be a list with a url");
        }

        const imported = await profiles.importListed(caller.id, url, paths);

        log("profiles imported", {
          profileIds: imported.map(({ id }) => id),
        });

        return { profiles: imported };
      }

      const profile =
        url === undefined
          ? profiles.import(caller.id, body)
          : await profiles.importFromGit(caller.id, url);

      log("profile imported", { profileId: profile.id });

      return profile;
    },
    "profiles.get": ({ params: { id }, caller }) =>
      found(profiles.get(caller.id, id)),
    "profiles.update": ({ params: { id }, body, caller }) => {
      const updated = ok(profiles.update(caller.id, id, body, caller.admin));
      log("profile updated", { profileId: id });

      return updated;
    },
    "profiles.remove": ({ params: { id }, caller }) => {
      ok(profiles.remove(caller.id, id, caller.admin));
      log("profile deleted", { profileId: id });

      return undefined;
    },
    // What a repository's pipoca.json lists, to pick from (ADR 0063).
    "profiles.listed": async ({ body: { url } }) => ({
      profiles: await profiles.listed(url),
    }),
    "profiles.syncs.create": async ({ params: { id }, caller }) =>
      ok(await profiles.syncOne(log, caller.id, id)),
    "profiles.copy": ({ params: { id }, caller }) => {
      const copied = ok(profiles.copy(caller.id, id));
      log("profile copied", { profileId: copied.id, from: id });

      return copied;
    },
    "profiles.default": ({ params: { id }, caller }) =>
      ok(profiles.makeDefault(caller.id, id)),
    "profiles.archive": async ({ params: { id }, caller }) => {
      const archive = found(await profiles.archive(caller.id, id));

      return new Response(archive, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${id}.tar.gz"`,
        },
      });
    },
    // A Profile's folder, file by file (ADR 0041).
    "profiles.files": ({ params: { id }, caller }) =>
      found(profiles.files(caller.id, id)),
    // Uploads files and folders as { files: { path: base64 } }, the way
    // runners get them.
    "profiles.files.upload": ({ params: { id }, body, caller }) => {
      const files = decoded(body.files);
      ok(profiles.writeFiles(caller.id, id, files, caller.admin));
      log("profile files uploaded", { profileId: id, files: files.size });

      return undefined;
    },
    "profiles.file": ({ params: { id, path: encoded }, caller }) =>
      new Response(found(profiles.file(caller.id, id, filePath(encoded)))),
    "profiles.file.write": async ({
      request,
      params: { id, path: encoded },
      caller,
    }) => {
      ok(
        profiles.writeFiles(
          caller.id,
          id,
          new Map([[filePath(encoded), Buffer.from(await request.bytes())]]),
          caller.admin,
        ),
      );

      log("profile file written", { profileId: id });

      return undefined;
    },
    "profiles.file.remove": ({ params: { id, path: encoded }, caller }) => {
      ok(profiles.deleteFile(caller.id, id, filePath(encoded), caller.admin));
      log("profile file deleted", { profileId: id });

      return undefined;
    },
    ...layerRoutes(profiles, "base", "base profile", log),
    ...layerRoutes(profiles, "defaults", "my defaults", log),
  };
}

// The admin's base Profile (ADR 0044) and each person's My defaults
// (ADR 0063), the layers under every Profile.
function layerRoutes<const Which extends Layer>(
  profiles: Profiles,
  which: Which,
  name: string,
  log: ApiDeps["log"],
): Handlers<Group<`layers.${Which}`>> {
  const handlers: Handlers<Group<"layers.base">> = {
    "layers.base": ({ caller }) => profiles.layer(caller.id, which),
    "layers.base.update": ({ body, caller }) => {
      const updated = ok(
        profiles.updateLayer(caller.id, which, body, caller.admin),
      );

      log(`${name} updated`);

      return updated;
    },
    "layers.base.files": ({ caller }) => profiles.layerFiles(caller.id, which),
    "layers.base.files.upload": ({ body, caller }) => {
      const files = decoded(body.files);
      ok(profiles.writeLayerFiles(caller.id, which, files, caller.admin));
      log(`${name} files uploaded`, { files: files.size });

      return undefined;
    },
    "layers.base.file": ({ params: { path: encoded }, caller }) =>
      new Response(
        found(profiles.layerFile(caller.id, which, filePath(encoded))),
      ),
    "layers.base.file.write": async ({
      request,
      params: { path: encoded },
      caller,
    }) => {
      ok(
        profiles.writeLayerFiles(
          caller.id,
          which,
          new Map([[filePath(encoded), Buffer.from(await request.bytes())]]),
          caller.admin,
        ),
      );

      log(`${name} file written`);

      return undefined;
    },
    "layers.base.file.remove": ({ params: { path: encoded }, caller }) => {
      ok(
        profiles.deleteLayerFile(
          caller.id,
          which,
          filePath(encoded),
          caller.admin,
        ),
      );

      log(`${name} file deleted`);

      return undefined;
    },
  };

  // Both layers' routes have the same shapes, so one set of handlers
  // answers either.
  return Object.fromEntries(
    Object.entries(handlers).map(([key, handler]) => [
      key.replace("layers.base", `layers.${which}`),
      handler,
    ]),
  ) as unknown as Handlers<Group<`layers.${Which}`>>;
}

function found<T>(value: T | undefined | null | false): T {
  if (value === undefined || value === null || value === false) {
    throw new NotFound("Not found.");
  }

  return value;
}

function decoded(files: Readonly<Record<string, string>>): Map<string, Buffer> {
  return new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      Buffer.from(content, "base64"),
    ]),
  );
}

// A file's path as it arrives in a URL, percent-encoded.
function filePath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new BadRequest("path isn't valid percent-encoding");
  }
}
