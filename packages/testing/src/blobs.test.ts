import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Config,
  definePlugin,
  defineServer,
  defineSession,
  NotFound,
  Type,
} from "@pipoca/plugins";
import { type PluginTest, person, testPlugin, testSession } from "./index";

const keeper = definePlugin({
  id: "keeper",
  title: "Keeper",
  description: "Keeps files a Session uploads.",
  config: Config.object({
    maxMb: Config.number({ title: "Largest file", default: 20 }),
  }),
});

const server = defineServer(keeper, ({ blobs, config, routes }) => {
  blobs.acceptUploads({ maxBytes: () => config.get().maxMb * 1024 * 1024 });

  routes.get("kept/:hash", { auth: "session" }, async ({ params }) => {
    const stream = await blobs.read(params.hash);

    if (stream === undefined) {
      throw new NotFound(`no blob ${params.hash}`);
    }

    return new Response(stream);
  });
});

const session = defineSession(keeper, (s) => {
  s.tools.define({
    name: "keep",
    label: "Keep",
    description: "Uploads a file.",
    params: Type.Object({ path: Type.String() }),
    annotations: { readOnly: true },
    run: async ({ path }) => {
      const kept = await s.blobs.upload(path);

      return `${kept.hash} ${String(kept.size)}`;
    },
  });
});

const tests: PluginTest[] = [];

afterEach(async () => {
  await Promise.all(tests.splice(0).map(async (each) => each.close()));
});

interface Sent {
  readonly method: string;
  readonly path: string;
}

async function setUp(
  o: {
    readonly maxMb?: number;
    // Throws as a dropped connection would on this request, once.
    readonly dropOn?: (sent: Sent) => boolean;
  } = {},
): Promise<{
  readonly keep: (bytes: Uint8Array) => Promise<string>;
  readonly kept: (hash: string) => Promise<Uint8Array>;
  readonly sent: readonly Sent[];
}> {
  const t = await testPlugin(server, {
    people: [{ id: "ana" }],
    ...(o.maxMb !== undefined && { config: { maxMb: o.maxMb } }),
  });

  tests.push(t);
  const host = await t.session({ owner: person("ana") });
  const sent: Sent[] = [];
  let dropped = false;
  const dir = await mkdtemp(join(tmpdir(), "keeper-"));

  const part = await testSession(session, {
    request: async (path, init) => {
      const request = { method: init?.method ?? "GET", path };
      sent.push(request);

      if (!dropped && o.dropOn?.(request) === true) {
        dropped = true;

        throw new TypeError("fetch failed");
      }

      return host.api.raw(path, init);
    },
  });

  return {
    keep: async (bytes) => {
      const file = join(dir, "file.bin");
      await writeFile(file, bytes);
      const answer = await part.tool("keep", { path: file });

      if (answer.isError) {
        throw new Error(answer.text);
      }

      return answer.text;
    },
    kept: async (hash) =>
      new Uint8Array(await (await host.api.raw(`kept/${hash}`)).arrayBuffer()),
    sent,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const puts = (sent: readonly Sent[]): readonly string[] =>
  sent.filter(({ method }) => method === "PUT").map(({ path }) => path);

test("a file larger than a chunk reaches the server whole, under its hash", async () => {
  const { keep, kept, sent } = await setUp();
  const bytes = new Uint8Array(randomBytes(9 * 1024 * 1024));

  expect(await keep(bytes)).toBe(`${sha256(bytes)} ${String(bytes.length)}`);
  expect(await kept(sha256(bytes))).toEqual(bytes);

  expect(puts(sent).map((path) => path.split("?")[1])).toEqual([
    "offset=0",
    "offset=8388608",
  ]);
});

test("an upload cut off mid-file carries on from what the server has", async () => {
  const { keep, kept, sent } = await setUp({
    dropOn: ({ method, path }) =>
      method === "PUT" && path.endsWith("offset=8388608"),
  });

  const bytes = new Uint8Array(randomBytes(9 * 1024 * 1024));

  await keep(bytes);

  expect(await kept(sha256(bytes))).toEqual(bytes);

  expect(puts(sent).map((path) => path.split("?")[1])).toEqual([
    "offset=0",
    "offset=8388608",
    "offset=8388608",
  ]);
});

test("a file the server already has isn't sent again", async () => {
  const { keep, sent } = await setUp();
  const bytes = new Uint8Array(randomBytes(1024));

  await keep(bytes);
  await keep(bytes);

  expect(puts(sent)).toHaveLength(1);
});

test("a file over the plugin's limit is refused without retries", async () => {
  const { keep, sent } = await setUp({ maxMb: 1 });

  const refused = await keep(new Uint8Array(2 * 1024 * 1024)).catch(
    (error: unknown) => error,
  );

  expect(refused).toBeInstanceOf(Error);

  expect((refused as Error).message).toBe(
    "files can be up to 1 MB on this server",
  );

  expect(puts(sent)).toHaveLength(1);
});
