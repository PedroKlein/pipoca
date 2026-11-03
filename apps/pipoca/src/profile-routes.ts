import { BadRequest, fieldsOf, readJson } from "@pipoca/plugins";
import type { Layer, Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import { userIdOf } from "@pipoca/pluginhost";
import { errorReply, notFound, reply } from "./replies";
import type { BrowserRoute } from "./server";

const profileRejections = {
  not_found: [404, "There is no such Profile."],
  default: [409, "The default Profile can't be removed."],
  in_use: [409, "Sessions still use this Profile."],
  admin_only: [403, "Only admins change shared Profiles."],
  synced: [
    409,
    "This Profile follows its repository. Make a copy to change it.",
  ],
} as const;

const layers = [
  ["base", "base profile"],
  ["defaults", "my defaults"],
] as const;

// Shared Profiles are changed only by admins (ADR 0041).
export function profileRoutes(
  profiles: Profiles,
  log: Log,
): readonly (readonly [string, RegExp, BrowserRoute])[] {
  const replied = (
    result: ReturnType<
      | Profiles["create"]
      | Profiles["update"]
      | Profiles["updateLayer"]
      | Profiles["remove"]
      | Profiles["copy"]
    >,
    status: number,
  ): Response =>
    result.ok
      ? reply(result, status)
      : errorReply(
          profileRejections[result.reason][0],
          result.reason,
          profileRejections[result.reason][1],
        );

  const layerRoutes = (
    which: Layer,
    name: string,
  ): readonly (readonly [string, RegExp, BrowserRoute])[] => {
    const at = (rest = "") => new RegExp(`^/api/${which}${rest}$`);

    return [
      [
        "GET",
        at(),
        (_request, _params, actor) =>
          Response.json(profiles.layer(userIdOf(actor), which)),
      ],
      [
        "PUT",
        at(),
        async (request, _params, actor, admin) => {
          const updated = profiles.updateLayer(
            userIdOf(actor),
            which,
            await readJson(request),
            admin,
          );

          if (updated.ok) {
            log(`${name} updated`);
          }

          return replied(updated, 200);
        },
      ],
      [
        "GET",
        at("/files"),
        (_request, _params, actor) =>
          Response.json(profiles.layerFiles(userIdOf(actor), which)),
      ],
      [
        "POST",
        at("/files"),
        async (request, _params, actor, admin) => {
          const files = uploadedFiles(await readJson(request));

          const written = profiles.writeLayerFiles(
            userIdOf(actor),
            which,
            files,
            admin,
          );

          if (written.ok) {
            log(`${name} files uploaded`, { files: files.size });
          }

          return replied(written, 204);
        },
      ],
      [
        "GET",
        at("/files/(.+)"),
        (_request, [file = ""], actor) => {
          const content = profiles.layerFile(
            userIdOf(actor),
            which,
            filePath(file),
          );

          return content ? new Response(content) : notFound();
        },
      ],
      [
        "PUT",
        at("/files/(.+)"),
        async (request, [file = ""], actor, admin) => {
          const written = profiles.writeLayerFiles(
            userIdOf(actor),
            which,
            new Map([[filePath(file), Buffer.from(await request.bytes())]]),
            admin,
          );

          if (written.ok) {
            log(`${name} file written`);
          }

          return replied(written, 204);
        },
      ],
      [
        "DELETE",
        at("/files/(.+)"),
        (_request, [file = ""], actor, admin) => {
          const removed = profiles.deleteLayerFile(
            userIdOf(actor),
            which,
            filePath(file),
            admin,
          );

          if (removed.ok) {
            log(`${name} file deleted`);
          }

          return replied(removed, 204);
        },
      ],
    ];
  };

  return [
    [
      "GET",
      /^\/api\/profiles$/,
      (_request, _params, actor) =>
        Response.json(profiles.list(userIdOf(actor))),
    ],
    [
      "POST",
      /^\/api\/profiles$/,
      async (request, _params, actor, admin) => {
        const created = profiles.create(
          userIdOf(actor),
          await readJson(request),
          admin,
        );

        if (created.ok) {
          log("profile created", { profileId: created.value.id });
        }

        return replied(created, 201);
      },
    ],
    // A body with a url imports from a git repository, any other body is an
    // exported Profile file.
    [
      "POST",
      /^\/api\/profiles\/import$/,
      async (request, _params, actor) => {
        if (request.headers.get("content-type") === "application/gzip") {
          const name = new URL(request.url).searchParams.get("name") ?? "";

          const imported = await profiles.importArchive(
            userIdOf(actor),
            name.trim() === "" ? "Imported" : name,
            await request.bytes(),
          );

          log("profile imported", { profileId: imported.id });

          return Response.json(imported, { status: 201 });
        }

        const body = await readJson(request);

        const { url, paths } = (body ?? {}) as Record<string, unknown>;

        if (url !== undefined && typeof url !== "string") {
          throw new BadRequest("url must be a string");
        }

        if (paths !== undefined) {
          if (
            url === undefined ||
            !Array.isArray(paths) ||
            !paths.every((path) => typeof path === "string")
          ) {
            throw new BadRequest("paths must be a list with a url");
          }

          const imported = await profiles.importListed(
            userIdOf(actor),
            url,
            paths,
          );

          log("profiles imported", {
            profileIds: imported.map(({ id }) => id),
          });

          return Response.json({ profiles: imported }, { status: 201 });
        }

        const profile =
          url === undefined
            ? profiles.import(userIdOf(actor), body)
            : await profiles.importFromGit(userIdOf(actor), url);

        log("profile imported", { profileId: profile.id });

        return Response.json(profile, { status: 201 });
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""], actor) => {
        const profile = profiles.get(userIdOf(actor), id);

        return profile ? Response.json(profile) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)$/,
      async (request, [id = ""], actor, admin) => {
        const updated = profiles.update(
          userIdOf(actor),
          id,
          await readJson(request),
          admin,
        );

        if (updated.ok) {
          log("profile updated", { profileId: id });
        }

        return replied(updated, 200);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""], actor, admin) => {
        const removed = profiles.remove(userIdOf(actor), id, admin);
        if (removed.ok) {
          log("profile deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
    // What a repository's pipoca.json lists, to pick from (ADR 0063).
    [
      "POST",
      /^\/api\/profiles\/listed$/,
      async (request) => {
        const { url } = fieldsOf(await readJson(request));

        if (typeof url !== "string") {
          throw new BadRequest("url must be a string");
        }

        return Response.json({ profiles: await profiles.listed(url) });
      },
    ],
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/sync$/,
      async (_request, [id = ""], actor) =>
        replied(await profiles.syncOne(log, userIdOf(actor), id), 200),
    ],
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/copy$/,
      (_request, [id = ""], actor) => {
        const copied = profiles.copy(userIdOf(actor), id);

        if (copied.ok) {
          log("profile copied", { profileId: copied.value.id, from: id });
        }

        return replied(copied, 201);
      },
    ],
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/default$/,
      (_request, [id = ""], actor) =>
        replied(profiles.makeDefault(userIdOf(actor), id), 200),
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/export$/,
      async (_request, [id = ""], actor) => {
        const archive = await profiles.archive(userIdOf(actor), id);
        if (!archive) {
          return notFound();
        }

        return new Response(archive, {
          headers: {
            "content-type": "application/gzip",
            "content-disposition": `attachment; filename="${id}.tar.gz"`,
          },
        });
      },
    ],
    // The admin's base Profile (ADR 0044) and each person's My defaults
    // (ADR 0063), the layers under every Profile.
    ...layers.flatMap(([which, name]) => layerRoutes(which, name)),
    // A Profile's folder, file by file (ADR 0041).
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files$/,
      (_request, [id = ""], actor) => {
        const files = profiles.files(userIdOf(actor), id);

        return files ? Response.json(files) : notFound();
      },
    ],
    // Uploads files and folders as { files: { path: base64 } }, the way
    // runners get them.
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/files$/,
      async (request, [id = ""], actor, admin) => {
        const decoded = uploadedFiles(await readJson(request));

        const written = profiles.writeFiles(
          userIdOf(actor),
          id,
          decoded,
          admin,
        );

        if (written.ok) {
          log("profile files uploaded", {
            profileId: id,
            files: decoded.size,
          });
        }

        return replied(written, 204);
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""], actor) => {
        const file = profiles.file(userIdOf(actor), id, filePath(path));

        return file ? new Response(file) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      async (request, [id = "", path = ""], actor, admin) => {
        const written = profiles.writeFiles(
          userIdOf(actor),
          id,
          new Map([[filePath(path), Buffer.from(await request.bytes())]]),
          admin,
        );

        if (written.ok) {
          log("profile file written", { profileId: id });
        }

        return replied(written, 204);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""], actor, admin) => {
        const removed = profiles.deleteFile(
          userIdOf(actor),
          id,
          filePath(path),
          admin,
        );

        if (removed.ok) {
          log("profile file deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
  ];
}

function uploadedFiles(body: unknown): Map<string, Buffer> {
  const { files } = fieldsOf(body);
  if (
    typeof files !== "object" ||
    files === null ||
    Object.values(files).some((content) => typeof content !== "string")
  ) {
    throw new BadRequest("files must map paths to base64 contents");
  }

  return new Map(
    Object.entries(files as Record<string, string>).map(([path, content]) => [
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
