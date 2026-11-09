import { stat, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { defineSession, ToolError, Type } from "@pipoca/plugins";
import { artifacts } from "../plugin";
import {
  type ArtifactSummary,
  bytes,
  type Comment,
  kindOf,
  type Published,
  supported,
} from "./artifacts";

const shownThreads = 30;

// Pi publishes a file from its workspace as an artifact, or a new version of
// one, and reads artifacts back into its own folder (ADR 0078).
export const session = defineSession(artifacts, (s) => {
  s.tools.define({
    name: "publish_artifact",
    label: "Publish artifact",
    description: `Publishes a file from your workspace as an artifact people open beside the Session, at a link that stays the same. Without id it makes a new artifact; with the id of one this Session published it adds a version. Works for ${supported}. A page loads scripts only from allowed CDNs and nothing else from the network, so keep everything in the one file.`,
    params: Type.Object({
      path: Type.String({
        description: "The file, from your working directory",
      }),
      title: Type.Optional(
        Type.String({
          description: "What people see it as. Default: its name",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "The id an earlier publish_artifact returned, to add a version to it. Leave it out for a new artifact.",
        }),
      ),
      note: Type.Optional(
        Type.String({
          description:
            "What this version changed, in a few words, such as added the commit list",
        }),
      ),
    }),
    annotations: { destructive: false },
    // People are told about artifacts in the chat, so the guideline stays.
    exposure: "direct",
    prompt: {
      snippet: "Publish a page, document or picture for people to open",
      guidelines: [
        "When you make something for people to look at, such as a report, a page or a chart, publish it with publish_artifact, and publish changes to it as new versions with its id.",
      ],
    },
    run: async (input, { cwd, signal }) => {
      const path = resolve(cwd, input.path);
      const name = basename(path);

      if (kindOf(name) === undefined) {
        throw new ToolError(
          `${name} can't be an artifact: publish ${supported}`,
        );
      }

      const size = (await stat(path)).size;

      if (size > s.config.maxFileBytes) {
        throw new ToolError(
          `${name} is ${bytes(size)}; artifacts can be up to ${bytes(s.config.maxFileBytes)}`,
        );
      }

      const { hash } = await s.blobs.upload(
        path,
        signal === undefined ? {} : { signal },
      );

      const published = await s.api.post<Published>(
        "session/artifacts",
        {
          name,
          hash,
          ...(input.title !== undefined && { title: input.title }),
          ...(input.id !== undefined && { id: input.id }),
          ...(input.note !== undefined && { note: input.note.slice(0, 200) }),
        },
        signal === undefined ? {} : { signal },
      );

      return {
        text: `Published “${published.title}” as version ${String(published.version)} of artifact ${published.id}.`,
        details: published,
      };
    },
  });

  s.tools.define({
    name: "list_artifacts",
    label: "List artifacts",
    description:
      "Finds artifacts this Session published and ones its person opens, by words in their titles. Returns at most 20.",
    params: Type.Object({
      query: Type.String({
        description: "Words in the title; empty lists the newest",
      }),
    }),
    annotations: { readOnly: true },
    run: async ({ query }) => {
      const answer = await s.api.get<{
        artifacts: ArtifactSummary[];
        more: number;
      }>(`session/artifacts?query=${encodeURIComponent(query)}`);

      if (answer.artifacts.length === 0) {
        return "No artifacts match.";
      }

      const lines = answer.artifacts.map((each) =>
        [
          each.id,
          each.title,
          each.kind,
          `${String(each.versions)} ${each.versions === 1 ? "version" : "versions"}`,
          ...(each.openComments > 0
            ? [
                `${String(each.openComments)} open ${each.openComments === 1 ? "comment" : "comments"}`,
              ]
            : []),
        ].join(" · "),
      );

      return answer.more > 0
        ? [...lines, `and ${String(answer.more)} more`].join("\n")
        : lines.join("\n");
    },
  });

  s.tools.define({
    name: "read_artifact",
    label: "Read artifact",
    description:
      "Copies an artifact's file, its newest version or the one asked for, into your folder and returns its path.",
    params: Type.Object({
      id: Type.String({ description: "The artifact's id" }),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    annotations: { readOnly: true },
    run: async ({ id, version }, { signal }) => {
      const response = await s.api.raw(
        `session/artifacts/${encodeURIComponent(id)}/file${version === undefined ? "" : `?v=${String(version)}`}`,
        signal === undefined ? {} : { signal },
      );

      if (!response.ok) {
        throw new ToolError(
          response.status === 404
            ? `no artifact ${id}${version === undefined ? "" : ` version ${String(version)}`}`
            : `artifact ${id} couldn't be read: ${String(response.status)}`,
        );
      }

      const name = basename(
        decodeURIComponent(response.headers.get("x-artifact-name") ?? "file"),
      );

      const number = response.headers.get("x-artifact-version") ?? "1";
      const folder = join(s.folder, id, `v${number}`);
      const path = join(folder, name);

      await mkdir(folder, { recursive: true });
      await writeFile(path, new Uint8Array(await response.arrayBuffer()));

      return `Wrote version ${number} of artifact ${id} to ${path}.`;
    },
  });

  s.tools.define({
    name: "read_artifact_comments",
    label: "Read artifact comments",
    description: `Reads the comments people left on an artifact, each with the version and the text it's about, and the replies under it. Open comments only, unless resolved is true. Returns at most ${String(shownThreads)}.`,
    params: Type.Object({
      id: Type.String({ description: "The artifact's id" }),
      resolved: Type.Optional(
        Type.Boolean({ description: "Also show resolved comments" }),
      ),
    }),
    annotations: { readOnly: true },
    prompt: {
      snippet: "Read what people commented on an artifact",
      guidelines: [
        "When someone asks about feedback or comments on an artifact, read them with read_artifact_comments.",
      ],
    },
    run: async ({ id, resolved = false }) => {
      const { comments } = await s.api.get<{ comments: Comment[] }>(
        `session/artifacts/${encodeURIComponent(id)}/comments`,
      );

      const threads = comments.filter(
        (each) => each.parent === null && (resolved || !each.resolved),
      );

      if (threads.length === 0) {
        return resolved ? "No comments yet." : "No open comments.";
      }

      const lines = threads
        .slice(0, shownThreads)
        .flatMap((thread) => [
          [
            `${thread.author} on version ${String(thread.version)}`,
            thread.quote === "" ? "" : `, about “${thread.quote}”`,
            thread.resolved ? " (resolved)" : "",
            `: ${thread.body}`,
          ].join(""),
          ...comments
            .filter((each) => each.parent === thread.id)
            .map((reply) => `  ${reply.author} replied: ${reply.body}`),
        ]);

      return threads.length > shownThreads
        ? [...lines, `and ${String(threads.length - shownThreads)} more`].join(
            "\n",
          )
        : lines.join("\n");
    },
  });
});
