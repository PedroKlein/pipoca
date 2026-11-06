import { HttpError, NotFound, Type } from "@pipoca/plugins";
import { checkBody, isObject } from "@pipoca/plugins/host";
import { type Profile, repositoryImport } from "@pipoca/protocol";
import type { Layer, Profiles } from "@pipoca/profiles";
import type { ApiDeps, Group } from "../deps";
import { type Handlers, type PersonCaller, restOf } from "../router";

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

// Where a new Profile comes from, when not from its content: a copy of
// another, a repository, or an exported Profile file.
const origin = Type.Object({
  from: Type.Optional(Type.String({ minLength: 1 })),
  ...Type.Partial(repositoryImport).properties,
  pipocaProfile: Type.Optional(Type.Unknown()),
});

// Shared Profiles are changed only by admins (ADR 0041).
export function profileRoutes({
  profiles,
  log,
}: ApiDeps): Handlers<
  | Group<"profiles">
  | Group<"me.profileDefaults">
  | Group<"settings.baseProfile">
> {
  // A team Session's route tool reaches only the team's Profiles
  // (ADR 0067).
  const reached = (id: string, caller: PersonCaller): string => {
    if (caller.team && profiles.get(caller.id, id)?.ownerId !== "team") {
      throw new NotFound("Not found.");
    }

    return id;
  };

  const created = async (
    body: unknown,
    caller: PersonCaller,
  ): Promise<Profile> => {
    const { from, source, pipocaProfile } = isObject(body)
      ? checkBody(body, origin)
      : {};

    const copies =
      from !== undefined || source !== undefined || pipocaProfile !== undefined;

    if (caller.team && copies) {
      throw new HttpError(
        403,
        "A team Session's tools make team Profiles only from their content.",
        "forbidden",
      );
    }

    if (from !== undefined) {
      const copied = ok(profiles.copy(caller.id, from));
      log("profile copied", { profileId: copied.id, from });

      return copied;
    }

    if (source !== undefined) {
      const [imported] =
        source.path === undefined
          ? [await profiles.importFromGit(caller.id, source.url)]
          : await profiles.importListed(caller.id, source.url, [source.path]);

      if (imported === undefined) {
        throw new NotFound("The repository lists no Profile there.");
      }

      log("profile imported", { profileId: imported.id });

      return imported;
    }

    if (pipocaProfile !== undefined) {
      const imported = profiles.import(caller.id, body);
      log("profile imported", { profileId: imported.id });

      return imported;
    }

    const made = ok(
      profiles.create(
        caller.id,
        caller.team && isObject(body) ? { ...body, team: true } : body,
        caller.admin,
      ),
    );

    log("profile created", { profileId: made.id });

    return made;
  };

  return {
    "profiles.list": ({ query: { scope }, caller }) =>
      profiles.list(caller.id, { team: scope === "team" || caller.team }),
    "profiles.create": async ({ body, caller }) => created(body, caller),
    "profiles.archives.create": async ({ request, query, caller }) => {
      const name = query.name ?? "";

      const imported = await profiles.importArchive(
        caller.id,
        name.trim() === "" ? "Imported" : name,
        await request.bytes(),
      );

      log("profile imported", { profileId: imported.id });

      return imported;
    },
    "profiles.get": ({ params: { id }, caller }) =>
      found(profiles.get(caller.id, reached(id, caller))),
    "profiles.update": ({ params: { id }, body, caller }) => {
      reached(id, caller);

      const { isDefault, ...content } = isObject(body)
        ? body
        : ({} as Readonly<Record<string, unknown>>);

      let updated = profiles.get(caller.id, id);

      if (Object.keys(content).length > 0 || isDefault === undefined) {
        updated = ok(profiles.update(caller.id, id, content, caller.admin));
        log("profile updated", { profileId: id });
      }

      if (isDefault === true) {
        updated = ok(profiles.makeDefault(caller.id, id));
      }

      return found(updated);
    },
    "profiles.remove": ({ params: { id }, caller }) => {
      ok(profiles.remove(caller.id, reached(id, caller), caller.admin));
      log("profile deleted", { profileId: id });

      return undefined;
    },
    "profiles.syncs.create": async ({ params: { id }, caller }) =>
      ok(await profiles.syncOne(log, caller.id, reached(id, caller))),
    "profiles.archive": async ({ params: { id }, caller }) => {
      const archive = found(
        await profiles.archive(caller.id, reached(id, caller)),
      );

      return new Response(archive, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${id}.tar.gz"`,
        },
      });
    },
    // A Profile's folder, file by file (ADR 0041).
    "profiles.files": ({ params: { id }, caller }) =>
      found(profiles.files(caller.id, reached(id, caller))),
    // Uploads files and folders as { files: { path: base64 } }, the way
    // runners get them.
    "profiles.files.upload": ({ params: { id }, body, caller }) => {
      const files = decoded(body.files);

      ok(
        profiles.writeFiles(
          caller.id,
          reached(id, caller),
          files,
          caller.admin,
        ),
      );

      log("profile files uploaded", { profileId: id, files: files.size });

      return undefined;
    },
    "profiles.file": ({ params: { id, path: encoded }, caller }) =>
      new Response(
        found(profiles.file(caller.id, reached(id, caller), restOf(encoded))),
      ),
    "profiles.file.write": async ({
      request,
      params: { id, path: encoded },
      caller,
    }) => {
      ok(
        profiles.writeFiles(
          caller.id,
          reached(id, caller),
          new Map([[restOf(encoded), Buffer.from(await request.bytes())]]),
          caller.admin,
        ),
      );

      log("profile file written", { profileId: id });

      return undefined;
    },
    "profiles.file.remove": ({ params: { id, path: encoded }, caller }) => {
      ok(
        profiles.deleteFile(
          caller.id,
          reached(id, caller),
          restOf(encoded),
          caller.admin,
        ),
      );

      log("profile file deleted", { profileId: id });

      return undefined;
    },
    ...layerRoutes(
      profiles,
      "base",
      "settings.baseProfile",
      "base profile",
      log,
    ),
    ...layerRoutes(
      profiles,
      "defaults",
      "me.profileDefaults",
      "my defaults",
      log,
    ),
  };
}

type LayerKey = "settings.baseProfile" | "me.profileDefaults";

// The admin's base Profile (ADR 0044) and each person's My defaults
// (ADR 0063), the layers under every Profile.
function layerRoutes<const Key extends LayerKey>(
  profiles: Profiles,
  which: Layer,
  key: Key,
  name: string,
  log: ApiDeps["log"],
): Handlers<Group<Key>> {
  const handlers: Handlers<Group<"settings.baseProfile">> = {
    "settings.baseProfile": ({ caller }) => profiles.layer(caller.id, which),
    "settings.baseProfile.update": ({ body, caller }) => {
      const updated = ok(
        profiles.updateLayer(caller.id, which, body, caller.admin),
      );

      log(`${name} updated`);

      return updated;
    },
    "settings.baseProfile.files": ({ caller }) =>
      profiles.layerFiles(caller.id, which),
    "settings.baseProfile.files.upload": ({ body, caller }) => {
      const files = decoded(body.files);
      ok(profiles.writeLayerFiles(caller.id, which, files, caller.admin));
      log(`${name} files uploaded`, { files: files.size });

      return undefined;
    },
    "settings.baseProfile.file": ({ params: { path: encoded }, caller }) =>
      new Response(
        found(profiles.layerFile(caller.id, which, restOf(encoded))),
      ),
    "settings.baseProfile.file.write": async ({
      request,
      params: { path: encoded },
      caller,
    }) => {
      ok(
        profiles.writeLayerFiles(
          caller.id,
          which,
          new Map([[restOf(encoded), Buffer.from(await request.bytes())]]),
          caller.admin,
        ),
      );

      log(`${name} file written`);

      return undefined;
    },
    "settings.baseProfile.file.remove": ({
      params: { path: encoded },
      caller,
    }) => {
      ok(
        profiles.deleteLayerFile(
          caller.id,
          which,
          restOf(encoded),
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
    Object.entries(handlers).map(([route, handler]) => [
      route.replace("settings.baseProfile", key),
      handler,
    ]),
  ) as unknown as Handlers<Group<Key>>;
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
