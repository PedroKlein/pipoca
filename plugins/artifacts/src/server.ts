import {
  BadRequest,
  defineServer,
  Forbidden,
  HttpError,
  NotFound,
  owners,
  type PersonCaller,
  type SessionCaller,
  StringEnum,
  Type,
} from "@pipoca/plugins";
import { type Actor, blobHash, type Owner } from "@pipoca/protocol";
import { artifacts } from "../plugin";
import {
  type Access,
  type ArtifactSummary,
  type Audience,
  type ArtifactView,
  type Comment,
  bytes,
  kindOf,
  type Published,
  type Role,
  type Share,
  supported,
  type Version,
} from "./artifacts";
import { rendered } from "./render";

interface Row {
  readonly id: string;
  readonly session_id: string | null;
  readonly owner_user_id: string | null;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface VersionRow {
  readonly number: number;
  readonly name: string;
  readonly hash: string;
  readonly size: number;
  readonly author: string;
  readonly note: string;
  readonly created_at: number;
}

const shownMatches = 20;
const listed = 500;

const version = Type.Object({
  v: Type.Optional(Type.Integer({ minimum: 1 })),
});

// Artifacts, their versions' bytes in the plugin's blob store (ADR 0078).
export const server = defineServer(
  artifacts,
  ({ blobs, clock, config, log, people, routes, sessions, store }) => {
    const maxFileBytes = (): number => config.get().maxFileBytes;

    blobs.acceptUploads({ maxBytes: maxFileBytes });

    const row = (id: string): Row | undefined =>
      store.get<Row>("select * from artifacts_artifacts where id = ?", id);

    const versions = (id: string): readonly VersionRow[] =>
      store.all<VersionRow>(
        "select number, name, hash, size, author, note, created_at from artifacts_versions where artifact_id = ? order by number",
        id,
      );

    const shares = (id: string): readonly Share[] =>
      store
        .all<{ user_id: string; role: Role }>(
          "select user_id, role from artifacts_shares where artifact_id = ? order by user_id",
          id,
        )
        .map(({ user_id, role }) => ({
          userId: user_id,
          name: people.get(user_id)?.name ?? user_id,
          role,
        }));

    // An artifact follows its Session; once the Session is gone, its owner
    // keeps it. Named people open it too.
    const sees = (artifact: Row, person: string): boolean =>
      (artifact.session_id !== null &&
        sessions.sees(artifact.session_id, person)) ||
      (artifact.session_id === null &&
        (artifact.owner_user_id === null ||
          artifact.owner_user_id === person)) ||
      store.get(
        "select 1 from artifacts_shares where artifact_id = ? and user_id = ?",
        artifact.id,
        person,
      ) !== undefined;

    const steers = (artifact: Row, person: string): boolean =>
      artifact.session_id === null
        ? artifact.owner_user_id === null || artifact.owner_user_id === person
        : sessions.steers(artifact.session_id, person);

    // Comment access lets a person steer the Session through Pi, which the
    // share dialog says.
    const access = (artifact: Row, person: string): Access => {
      if (steers(artifact, person)) {
        return "steer";
      }

      return store.get(
        "select 1 from artifacts_shares where artifact_id = ? and user_id = ? and role = 'comment'",
        artifact.id,
        person,
      ) === undefined
        ? "view"
        : "comment";
    };

    const theirs = (id: string, caller: PersonCaller): Row => {
      const found = row(id);

      if (found === undefined || !sees(found, caller.person.id)) {
        throw new NotFound(`no artifact ${id}`);
      }

      return found;
    };

    const nameOf = (person: string | null): string =>
      person === null ? "Team" : (people.get(person)?.name ?? person);

    const audienceOf = (artifact: Row, named: number): Audience => {
      if (artifact.owner_user_id === null) {
        return "team";
      }

      return named > 0 ? "named" : "you";
    };

    // viewer is the person looking, or null for Pi.
    const summary = (artifact: Row, viewer: string | null): ArtifactSummary => {
      const all = versions(artifact.id);
      const last = all.at(-1);
      const named = shares(artifact.id);

      return {
        id: artifact.id,
        title: artifact.title,
        kind: kindOf(last?.name ?? "") ?? "html",
        sessionId: artifact.session_id,
        sessionTitle:
          artifact.session_id === null
            ? null
            : (sessions.get(artifact.session_id)?.title ?? null),
        owner: nameOf(artifact.owner_user_id),
        yours: viewer !== null && steers(artifact, viewer),
        audience: audienceOf(artifact, named.length),
        sharedWith: named.map(({ name }) => name),
        openComments:
          store.get<{ count: number }>(
            "select count(*) as count from artifacts_comments where artifact_id = ? and parent_id is null and resolved_at is null",
            artifact.id,
          )?.count ?? 0,
        versions: all.length,
        updatedAt: artifact.updated_at,
      };
    };

    const versionOf = (artifact: Row, number?: number): VersionRow => {
      const all = versions(artifact.id);
      const found = number === undefined ? all.at(-1) : all[number - 1];

      if (found === undefined) {
        throw new NotFound(`no version ${String(number)}`);
      }

      return found;
    };

    const content = async (found: VersionRow): Promise<Uint8Array> => {
      const kept = await blobs.bytes(found.hash);

      if (kept === undefined) {
        throw new NotFound(`version ${String(found.number)} is missing`);
      }

      return kept;
    };

    const addVersion = (
      id: string,
      name: string,
      hash: string,
      size: number,
      author: Actor,
      note = "",
    ): number => {
      const now = clock.now();
      const number = versions(id).length + 1;

      store.transaction(() => {
        store.run(
          "insert into artifacts_versions (artifact_id, number, name, hash, size, author, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          number,
          name,
          hash,
          size,
          author,
          note,
          now,
        );

        store.run(
          "update artifacts_artifacts set updated_at = ? where id = ?",
          now,
          id,
        );
      });

      return number;
    };

    const byOf = (author: string): string =>
      author.startsWith("user:") ? nameOf(author.slice("user:".length)) : "Pi";

    const view = (artifact: Row, person: string): ArtifactView => ({
      ...summary(artifact, person),
      history: versions(artifact.id).map((each): Version => ({
        number: each.number,
        name: each.name,
        size: each.size,
        author: each.author,
        by: byOf(each.author),
        note: each.note,
        createdAt: each.created_at,
      })),
      access: access(artifact, person),
      shares: shares(artifact.id),
      pinned:
        store.get(
          "select 1 from artifacts_pins where user_id = ? and artifact_id = ?",
          person,
          artifact.id,
        ) !== undefined,
    });

    const recent = (): readonly Row[] =>
      store.all<Row>(
        "select * from artifacts_artifacts order by updated_at desc limit ?",
        listed,
      );

    routes.get("artifacts", { auth: "person" }, ({ caller }) => ({
      artifacts: recent()
        .filter((each) => sees(each, caller.person.id))
        .map((each) => summary(each, caller.person.id)),
    }));

    // What a Session published, for its panel.
    routes.get(
      "sessions/:id/artifacts",
      { auth: "person" },
      ({ caller, params }) => ({
        artifacts: store
          .all<Row>(
            `select * from artifacts_artifacts where session_id = ?
             order by updated_at desc limit ?`,
            params.id,
            listed,
          )
          .filter((each) => sees(each, caller.person.id))
          .map((each) => summary(each, caller.person.id)),
      }),
    );

    routes.get("artifacts/:id", { auth: "person" }, ({ caller, params }) =>
      view(theirs(params.id, caller), caller.person.id),
    );

    routes.get(
      "artifacts/:id/view",
      { auth: "person", query: version },
      async ({ caller, params, query }) => {
        const found = versionOf(theirs(params.id, caller), query.v);

        return rendered(
          kindOf(found.name) ?? "html",
          found.name,
          await content(found),
          config.get().scriptHosts,
        );
      },
    );

    routes.get(
      "artifacts/:id/download",
      { auth: "person", query: version },
      async ({ caller, params, query }) => {
        const found = versionOf(theirs(params.id, caller), query.v);

        return new Response(await content(found), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": attachment(found.name),
          },
        });
      },
    );

    // An earlier version becomes the newest, as a version of its own.
    routes.post(
      "artifacts/:id/restore",
      {
        auth: "person",
        body: Type.Object({ version: Type.Integer({ minimum: 1 }) }),
        changes: ["artifacts"],
      },
      ({ caller, params, body }) => {
        const artifact = theirs(params.id, caller);

        if (!steers(artifact, caller.person.id)) {
          throw new NotFound(`no artifact ${params.id}`);
        }

        const found = versionOf(artifact, body.version);

        return {
          version: addVersion(
            artifact.id,
            found.name,
            found.hash,
            found.size,
            `user:${caller.person.id}`,
            `restored version ${String(found.number)}`,
          ),
        };
      },
    );

    // Pi can't change who opens an artifact: only people who steer it.
    routes.put(
      "artifacts/:id/shares",
      {
        auth: "person",
        body: Type.Object({
          shares: Type.Array(
            Type.Object({
              name: Type.String({ minLength: 1 }),
              role: StringEnum(["view", "comment"]),
            }),
            { maxItems: 200 },
          ),
        }),
        changes: ["artifacts"],
      },
      ({ caller, params, body }) => {
        const artifact = theirs(params.id, caller);

        if (!steers(artifact, caller.person.id)) {
          throw new NotFound(`no artifact ${params.id}`);
        }

        const named = body.shares.map(({ name, role }) => {
          const person = people.byName(name);

          if (person === undefined) {
            throw new BadRequest(`no one is called ${name}`);
          }

          return { id: person.id, role };
        });

        store.transaction(() => {
          store.run(
            "delete from artifacts_shares where artifact_id = ?",
            artifact.id,
          );

          for (const { id, role } of named) {
            store.run(
              "insert or replace into artifacts_shares (artifact_id, user_id, role) values (?, ?, ?)",
              artifact.id,
              id,
              role,
            );
          }
        });

        return { shares: shares(artifact.id) };
      },
    );

    routes.delete(
      "artifacts/:id",
      { auth: "person", changes: ["artifacts"] },
      async ({ caller, params }) => {
        const artifact = theirs(params.id, caller);

        if (!steers(artifact, caller.person.id)) {
          throw new NotFound(`no artifact ${params.id}`);
        }

        const hashes = versions(artifact.id).map(({ hash }) => hash);

        store.run("delete from artifacts_artifacts where id = ?", artifact.id);

        for (const hash of new Set(hashes)) {
          if (
            store.get(
              "select 1 from artifacts_versions where hash = ? limit 1",
              hash,
            ) === undefined
          ) {
            await blobs.remove(hash);
          }
        }

        return { deleted: artifact.id };
      },
    );

    const comments = (id: string): readonly Comment[] =>
      store
        .all<{
          id: string;
          version: number;
          parent_id: string | null;
          author_user_id: string | null;
          quote: string;
          body: string;
          sent_to_pi: number;
          resolved_at: number | null;
          created_at: number;
        }>(
          "select * from artifacts_comments where artifact_id = ? order by created_at, id",
          id,
        )
        .map((each) => ({
          id: each.id,
          version: each.version,
          parent: each.parent_id,
          author:
            each.author_user_id === null
              ? "Someone"
              : (people.get(each.author_user_id)?.name ?? each.author_user_id),
          quote: each.quote,
          body: each.body,
          sentToPi: each.sent_to_pi === 1,
          resolved: each.resolved_at !== null,
          createdAt: each.created_at,
        }));

    const commenter = (id: string, caller: PersonCaller): Row => {
      const artifact = theirs(id, caller);

      if (access(artifact, caller.person.id) === "view") {
        throw new Forbidden(
          "You can view this artifact but not comment on it.",
        );
      }

      return artifact;
    };

    routes.get(
      "artifacts/:id/comments",
      { auth: "person" },
      ({ caller, params }) => ({
        comments: comments(theirs(params.id, caller).id),
      }),
    );

    // A comment sent to Pi reaches the Session as the person's message and
    // wakes it.
    routes.post(
      "artifacts/:id/comments",
      {
        auth: "person",
        body: Type.Object({
          version: Type.Integer({ minimum: 1 }),
          body: Type.String({ minLength: 1, maxLength: 10_000 }),
          quote: Type.Optional(Type.String({ maxLength: 2000 })),
          parent: Type.Optional(Type.String({ minLength: 1 })),
          toPi: Type.Boolean(),
        }),
        changes: ["artifacts"],
      },
      ({ caller, params, body }) => {
        const artifact = commenter(params.id, caller);
        const found = versionOf(artifact, body.version);
        const id = Bun.randomUUIDv7();
        const toSession = body.toPi ? artifact.session_id : null;

        if (
          body.parent !== undefined &&
          !comments(artifact.id).some((each) => each.id === body.parent)
        ) {
          throw new NotFound(`no comment ${body.parent}`);
        }

        store.run(
          "insert into artifacts_comments (id, artifact_id, version, parent_id, author_user_id, quote, body, sent_to_pi, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          artifact.id,
          found.number,
          body.parent ?? null,
          caller.person.id,
          body.quote ?? "",
          body.body,
          toSession === null ? 0 : 1,
          clock.now(),
        );

        if (toSession !== null) {
          const about =
            body.quote === undefined || body.quote.trim() === ""
              ? ""
              : ` on “${body.quote.trim()}”`;

          sessions.send(toSession, {
            text: `${caller.person.name} commented on version ${String(found.number)} of the artifact “${artifact.title}” (${artifact.id})${about}: ${body.body}`,
            turn: true,
            as: `user:${caller.person.id}`,
          });
        }

        return { id, sentToPi: toSession !== null };
      },
    );

    routes.post(
      "artifacts/:id/comments/:comment/resolve",
      {
        auth: "person",
        body: Type.Object({ resolved: Type.Boolean() }),
        changes: ["artifacts"],
      },
      ({ caller, params, body }) => {
        const artifact = commenter(params.id, caller);

        store.run(
          "update artifacts_comments set resolved_at = ? where id = ? and artifact_id = ?",
          body.resolved ? clock.now() : null,
          params.comment,
          artifact.id,
        );

        return { resolved: body.resolved };
      },
    );

    // A person's edit of a Markdown artifact is a version of its own, which
    // Pi hears about with its author.
    routes.post(
      "artifacts/:id/versions",
      {
        auth: "person",
        body: Type.Object({ text: Type.String({ maxLength: 5_000_000 }) }),
        changes: ["artifacts"],
      },
      async ({ caller, params, body }) => {
        const artifact = theirs(params.id, caller);
        const last = versionOf(artifact);

        if (!steers(artifact, caller.person.id)) {
          throw new Forbidden(
            "Only people who steer its Session edit an artifact.",
          );
        }

        if (kindOf(last.name) !== "markdown") {
          throw new BadRequest("Only Markdown artifacts are edited here.");
        }

        const stored = await blobs.put(new TextEncoder().encode(body.text));

        const number = addVersion(
          artifact.id,
          last.name,
          stored.hash,
          stored.size,
          `user:${caller.person.id}`,
          "edited",
        );

        if (artifact.session_id !== null) {
          sessions.send(artifact.session_id, {
            text: `${caller.person.name} edited the artifact “${artifact.title}” (${artifact.id}): it's now version ${String(number)}. Read it with read_artifact before you change it.`,
            turn: false,
            as: `user:${caller.person.id}`,
          });
        }

        return { version: number };
      },
    );

    routes.put(
      "artifacts/:id/pin",
      {
        auth: "person",
        body: Type.Object({ pinned: Type.Boolean() }),
        changes: ["artifacts"],
      },
      ({ caller, params, body }) => {
        const artifact = theirs(params.id, caller);

        if (body.pinned) {
          store.run(
            "insert or ignore into artifacts_pins (user_id, artifact_id, pinned_at) values (?, ?, ?)",
            caller.person.id,
            artifact.id,
            clock.now(),
          );
        } else {
          store.run(
            "delete from artifacts_pins where user_id = ? and artifact_id = ?",
            caller.person.id,
            artifact.id,
          );
        }

        return { pinned: body.pinned };
      },
    );

    routes.get("pins", { auth: "person" }, ({ caller }) => ({
      artifacts: store
        .all<Row>(
          `select a.* from artifacts_artifacts a
           join artifacts_pins p on p.artifact_id = a.id
           where p.user_id = ? order by p.pinned_at`,
          caller.person.id,
        )
        .filter((each) => sees(each, caller.person.id))
        .map((each) => summary(each, caller.person.id)),
    }));

    // What a Session reaches: its own artifacts, and the ones the person
    // who started it opens.
    const reachable = (caller: SessionCaller, artifact: Row): boolean =>
      artifact.session_id === caller.session.id ||
      (caller.session.startedBy !== null &&
        sees(artifact, caller.session.startedBy));

    const sessionArtifact = (caller: SessionCaller, id: string): Row => {
      const found = row(id);

      if (found === undefined || !reachable(caller, found)) {
        throw new NotFound(`no artifact ${id}`);
      }

      return found;
    };

    routes.post(
      "session/artifacts",
      {
        auth: "session",
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 255 }),
          hash: Type.String({ pattern: blobHash.source }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          id: Type.Optional(Type.String({ minLength: 1 })),
          note: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        changes: ["artifacts"],
      },
      async ({ caller, body }): Promise<Published> => {
        if (kindOf(body.name) === undefined) {
          throw new BadRequest(
            `${body.name} can't be shown as an artifact: publish ${supported}`,
          );
        }

        const size = await blobs.size(body.hash);

        if (size === undefined) {
          throw new HttpError(
            409,
            `${body.name} isn't uploaded yet`,
            "missing",
          );
        }

        if (size > maxFileBytes()) {
          throw new HttpError(
            413,
            `${body.name} is ${bytes(size)}; artifacts can be up to ${bytes(maxFileBytes())} on this server`,
            "too_large",
          );
        }

        const author: Actor = `session:${caller.session.id}`;

        if (body.id !== undefined) {
          const artifact = row(body.id);

          if (artifact?.session_id !== caller.session.id) {
            throw new NotFound(
              `no artifact ${body.id} published from this Session`,
            );
          }

          if (body.title !== undefined) {
            store.run(
              "update artifacts_artifacts set title = ? where id = ?",
              body.title,
              artifact.id,
            );
          }

          const number = addVersion(
            artifact.id,
            body.name,
            body.hash,
            size,
            author,
            body.note,
          );

          return {
            id: artifact.id,
            title: body.title ?? artifact.title,
            version: number,
            kind: kindOf(body.name) ?? "html",
          };
        }

        const id = Bun.randomUUIDv7();
        const title = body.title ?? body.name;
        const owner: Owner = caller.session.ownedBy;

        store.run(
          "insert into artifacts_artifacts (id, session_id, owner_user_id, title, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
          id,
          caller.session.id,
          owners.toSql(owner),
          title,
          clock.now(),
          clock.now(),
        );

        addVersion(id, body.name, body.hash, size, author, body.note);
        log("artifact published", { id, session: caller.session.id });

        return { id, title, version: 1, kind: kindOf(body.name) ?? "html" };
      },
    );

    routes.get(
      "session/artifacts",
      {
        auth: "session",
        query: Type.Object({ query: Type.String({ maxLength: 200 }) }),
      },
      ({ caller, query }) => {
        const words = query.query.toLowerCase().split(/\s+/).filter(Boolean);

        const matches = recent()
          .filter((each) => reachable(caller, each))
          .filter((each) =>
            words.every((word) => each.title.toLowerCase().includes(word)),
          )
          .map((each) => summary(each, null));

        return {
          artifacts: matches.slice(0, shownMatches),
          more: Math.max(0, matches.length - shownMatches),
        };
      },
    );

    routes.get(
      "session/artifacts/:id/comments",
      { auth: "session" },
      ({ caller, params }) => ({
        comments: comments(sessionArtifact(caller, params.id).id),
      }),
    );

    routes.get(
      "session/artifacts/:id/file",
      { auth: "session", query: version },
      async ({ caller, params, query }) => {
        const found = versionOf(sessionArtifact(caller, params.id), query.v);

        return new Response(await content(found), {
          headers: {
            "content-type": "application/octet-stream",
            "x-artifact-name": encodeURIComponent(found.name),
            "x-artifact-version": String(found.number),
          },
        });
      },
    );
  },
);

// RFC 8187 leaves ' ( ) and * out of filename*, but encodeURIComponent keeps
// them.
function attachment(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}
