import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobRoutes, noticeType } from "@pipoca/protocol";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import { until } from "@pipoca/testing/until";
import type { FilesState, SessionFile } from "./files";
import { server } from "./server";
import { session } from "./session";

const tests: PluginTest[] = [];

afterEach(async () => {
  await Promise.all(tests.splice(0).map(async (each) => each.close()));
});

async function setUp(o: { readonly maxFileBytes?: number } = {}) {
  const t = await testPlugin(server, {
    people: [{ id: "ana", name: "Ana" }, { id: "bo" }],
    ...(o.maxFileBytes !== undefined && {
      config: { maxFileBytes: o.maxFileBytes },
    }),
  });

  tests.push(t);
  const host = await t.session({ owner: person("ana") });
  const published: FilesState[] = [];
  let offline = false;

  const runner = async () => {
    // The plugin's folder for the Session, which tests write in as Pi does.
    const cwd = await mkdtemp(join(tmpdir(), "files-"));

    const part = await testSession(session, {
      folder: cwd,
      ...(o.maxFileBytes !== undefined && {
        config: { maxFileBytes: o.maxFileBytes },
      }),
      publish: (key, data) => {
        if (key === "files") {
          published.push(data as FilesState);
        }
      },
      request: async (path, init) => {
        if (offline) {
          throw new TypeError("fetch failed");
        }

        return host.api.raw(path, init);
      },
    });

    return { cwd, part };
  };

  const listed = async (who = "ana") =>
    (await t.as(who).get<{ files: SessionFile[] }>(`sessions/${host.id}/files`))
      .files;

  const upload = async (name: string, bytes: string): Promise<string> => {
    const ana = t.as("ana");

    await ana.raw(`${blobRoutes.browserUpload.replace(":id", "u1")}?offset=0`, {
      method: "PUT",
      body: bytes,
    });

    const { hash } = await ana.post<{ hash: string }>(
      blobRoutes.browserFinish.replace(":id", "u1"),
      {},
    );

    return (
      await ana.post<{ path: string }>(`sessions/${host.id}/uploads`, {
        name,
        hash,
      })
    ).path;
  };

  return {
    t,
    host,
    runner,
    listed,
    upload,
    published,
    offline: (on: boolean) => {
      offline = on;
    },
  };
}

async function write(cwd: string, path: string, text: string): Promise<void> {
  const file = join(cwd, path);

  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

test("what Pi writes in outputs/ is saved after its turn and downloads whole", async () => {
  const { t, host, runner, listed } = await setUp();
  const { cwd, part } = await runner();

  await write(cwd, "outputs/report.md", "# Q3");
  await write(cwd, "outputs/data/by-customer.csv", "a,b");
  await part.event("agent_settled");
  await part.event("session_shutdown");

  expect(
    (await listed()).map(({ place, path, size }) => [place, path, size]),
  ).toEqual([
    ["outputs", "data/by-customer.csv", 3],
    ["outputs", "report.md", 4],
  ]);

  const download = await t
    .as("ana")
    .raw(`sessions/${host.id}/files/outputs?path=report.md`);

  expect(await download.text()).toBe("# Q3");
  expect(download.headers.get("content-disposition")).toContain("report.md");
});

test("an output Pi deletes goes from the server after its next turn", async () => {
  const { runner, listed } = await setUp();
  const { cwd, part } = await runner();

  await write(cwd, "outputs/draft.md", "one");
  await write(cwd, "outputs/final.md", "two");
  await part.event("agent_settled");
  await rm(join(cwd, "outputs/draft.md"));
  await part.event("agent_settled");
  await part.event("session_shutdown");

  expect((await listed()).map(({ path }) => path)).toEqual(["final.md"]);
});

test("outputs Pi deletes while they're being saved don't stop later saves", async () => {
  const { runner, listed } = await setUp();

  for (let round = 0; round < 20; round++) {
    const { cwd, part } = await runner();

    const names = Array.from(
      { length: 20 },
      (_, i) => `outputs/${String(i)}.md`,
    );

    await Promise.all(
      names.map(async (name) => write(cwd, name, "x".repeat(100_000))),
    );

    await part.event("agent_settled");
    await Promise.all(names.map(async (name) => rm(join(cwd, name))));
    await write(cwd, "outputs/kept.md", "kept");
    await part.event("agent_settled");
    await part.event("session_shutdown");
  }

  expect((await listed()).map(({ path }) => path)).toEqual(["kept.md"]);
});

test("outputs written while the server is unreachable are saved once it's back", async () => {
  const { runner, listed, published, offline } = await setUp();
  const { cwd, part } = await runner();

  offline(true);
  await write(cwd, "outputs/summary.md", "done");
  await part.event("agent_settled");
  await until(() => published.length > 0);

  expect(published.at(-1)?.unsaved).toEqual(["summary.md"]);

  offline(false);
  await part.event("session_shutdown");

  expect(published.at(-1)).toEqual({ unsaved: [] });
  expect((await listed()).map(({ path }) => path)).toEqual(["summary.md"]);
});

test("an output over the limit isn't sent, and the Session says why", async () => {
  const { runner, listed, published } = await setUp({ maxFileBytes: 4 });
  const { cwd, part } = await runner();

  await write(cwd, "outputs/big.bin", "12345");
  await write(cwd, "outputs/ok.txt", "1234");
  await part.event("agent_settled");
  await part.event("session_shutdown");

  expect((await listed()).map(({ path }) => path)).toEqual(["ok.txt"]);

  expect(published.at(-1)?.problem).toBe(
    "big.bin is larger than this server keeps.",
  );
});

// Pi's session entries for the notices the server sent the Session.
function noticesOf(host: Awaited<ReturnType<typeof setUp>>["host"]): {
  readonly sessionManager: { readonly getBranch: () => unknown[] };
} {
  const entries = host.delivered().map(({ notice }, at) => ({
    type: "custom_message",
    id: `entry-${String(at)}`,
    customType: noticeType,
    details: notice,
  }));

  return { sessionManager: { getBranch: () => entries } };
}

test("Pi hears of an upload as the person's notice, and finds it in uploads/ before its turn", async () => {
  const { host, runner, upload } = await setUp();
  const { cwd, part } = await runner();

  await part.event("session_start", {}, noticesOf(host));

  expect(await upload("statement.pdf", "%PDF")).toBe("statement.pdf");
  expect(await upload("statement.pdf", "%PDF-2")).toBe("statement (2).pdf");

  // The server hands a Session its notices in the background.
  await until(() => host.delivered().length === 2);

  expect(host.delivered().map(({ text, turn }) => [text, turn])).toEqual([
    ["Ana uploaded statement.pdf (4 B) to this Session.", false],
    ["Ana uploaded statement (2).pdf (6 B) to this Session.", false],
  ]);

  await part.event("before_agent_start", {}, noticesOf(host));

  expect(await readFile(join(cwd, "uploads/statement.pdf"), "utf8")).toBe(
    "%PDF",
  );

  expect(await readFile(join(cwd, "uploads/statement (2).pdf"), "utf8")).toBe(
    "%PDF-2",
  );
});

test("a runner the Session moves to copies its uploads when it starts", async () => {
  const { host, runner, upload } = await setUp();

  await upload("ledger.csv", "a,b");

  const next = await runner();

  await next.part.event("session_start", {}, noticesOf(host));
  await next.part.event("before_agent_start", {}, noticesOf(host));

  expect(await readFile(join(next.cwd, "uploads/ledger.csv"), "utf8")).toBe(
    "a,b",
  );
});

test("only people who see the Session list its files, and only those who steer it upload", async () => {
  const { t, host } = await setUp();

  expect((await t.as("bo").raw(`sessions/${host.id}/files`)).status).toBe(404);

  expect(
    (
      await t.as("bo").raw(`sessions/${host.id}/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", hash: "0".repeat(64) }),
      })
    ).status,
  ).toBe(404);
});

test("list_files finds outputs and uploads by words in their paths", async () => {
  const { runner, upload } = await setUp();
  const { cwd, part } = await runner();

  await upload("ledger-export.csv", "a");
  await write(cwd, "outputs/mismatches.csv", "b");
  await write(cwd, "outputs/notes.md", "c");
  await part.event("agent_settled");
  await part.event("session_shutdown");

  expect((await part.tool("list_files", { query: "csv" })).text).toBe(
    `${join(cwd, "outputs/mismatches.csv")} (1 B)\n${join(cwd, "uploads/ledger-export.csv")} (1 B)`,
  );

  expect((await part.tool("list_files", { query: "pdf" })).text).toBe(
    "No files match.",
  );
});
