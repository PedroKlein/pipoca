import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Environment, Session, SessionEvent } from "@pipoca/protocol";
import { readSse } from "@pipoca/protocol";
import { firstUserCookie, setupTokenOf } from "./testdata/sign-in";

const run = promisify(execFile);
let root: string;
let binary: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pipoca-build-"));
  binary = join(root, "pipoca");

  await run(process.execPath, ["src/build.ts", "--outfile", binary], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function startServer(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{
  readonly url: string;
  readonly server: ChildProcess;
  readonly cookie: string;
}> {
  const server = spawn(
    binary,
    ["server", "--port", "0", "--database", ":memory:", ...args],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } },
  );

  const lines: string[] = [];

  // The setup link follows the listening line.
  await new Promise((resolve) => {
    createInterface({ input: server.stderr }).on("line", (line) => {
      lines.push(line);
      if (line.includes("#setup/")) {
        resolve(undefined);
      }
    });
  });

  const listening = lines.find((line) => line.includes("server listening"));
  const { url } = JSON.parse(listening ?? "{}") as { url: string };

  return {
    url,
    server,
    cookie: await firstUserCookie(fetch, url, setupTokenOf(lines)),
  };
}

// A compiled binary has no Pi package.json beside it, where Pi reads its version.
test("a compiled server reports the version of Pi it bundles", async () => {
  const pi = JSON.parse(
    await readFile(
      fileURLToPath(
        import.meta.resolve("@earendil-works/pi-coding-agent/package.json"),
      ),
      "utf8",
    ),
  ) as { version: string };

  const { url, server } = await startServer([]);

  try {
    const health = await fetch(new URL("/healthz", url));

    expect(await health.json()).toMatchObject({ pi: pi.version });
  } finally {
    server.kill("SIGTERM");
  }
}, 30_000);

// Mermaid alone is megabytes, so a slow link waits minutes on plain scripts.
test("a compiled server sends the web app's scripts compressed and cached for good", async () => {
  const { url, server } = await startServer([]);

  try {
    const page = await (await fetch(new URL("/", url))).text();
    const script = /<script[^>]* src="([^"]+)"/.exec(page)?.[1] ?? "";

    const zipped = await fetch(new URL(script, url), {
      headers: { "accept-encoding": "gzip" },
    });

    const plain = await fetch(new URL(script, url), {
      headers: { "accept-encoding": "identity" },
    });

    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("cache-control")).toContain("immutable");
    expect(zipped.headers.get("content-type")).toContain("javascript");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await zipped.text()).toBe(await plain.text());
  } finally {
    server.kill("SIGTERM");
  }
}, 30_000);

// Pi loads its OAuth flows through an import a bundler can't follow. Copilot
// derives its API host from the token, so the request reaching that host shows
// the flow ran. A proxy records the host and refuses the connection.
test("a compiled server sends requests with a Copilot OAuth login", async () => {
  const dataDir = join(root, "data");
  const folder = join(root, "work");
  await mkdir(dataDir, { recursive: true });
  await mkdir(folder, { recursive: true });

  const connects: string[] = [];

  const proxy = createServer().on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;

  const { url, server, cookie } = await startServer(
    ["--provider", "local", "--data-dir", dataDir, "--folder", folder],
    {
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    },
  );

  try {
    const saved = await fetch(new URL("/api/ext/logins/save", url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "github-copilot",
        credential: {
          type: "oauth",
          refresh: "ghu_test",
          access: "tid=test;exp=9999999999;proxy-ep=proxy.copilot.test;",
          expires: Date.now() + 3_600_000,
        },
      }),
    });

    expect(saved.status).toBe(200);

    let environment: Environment | undefined;
    while (environment === undefined) {
      const environments = (await (
        await fetch(new URL("/api/environments", url), { headers: { cookie } })
      ).json()) as Environment[];

      environment = environments.find((e) => e.provider === "local");
    }

    const session = (await (
      await fetch(new URL("/api/sessions", url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          environment: environment.id,
          workspace: { kind: "folder", path: folder },
          model: { provider: "github-copilot", id: "gpt-5-mini" },
          firstMessage: "hi",
        }),
      })
    ).json()) as Session;

    const events = new AbortController();

    const response = await fetch(
      new URL(`/api/sessions/${session.id}/events`, url),
      { signal: events.signal, headers: { cookie } },
    );

    let reply: { errorMessage?: string } | undefined;
    for await (const event of readSse(response)) {
      const { message } =
        (event as SessionEvent).type === "entry"
          ? (JSON.parse((event as { entry: string }).entry) as {
              message?: { role: string; errorMessage?: string };
            })
          : {};

      if (message?.role === "assistant") {
        reply = message;
        break;
      }
    }

    events.abort();

    expect(reply?.errorMessage).not.toContain("OAuth");
    expect(connects).toContain("api.copilot.test:443");
  } finally {
    server.kill("SIGTERM");
    proxy.close();
  }
}, 30_000);

// pi-subagents starts a compiled host's own binary as Pi's CLI to run a
// background run, with the run in an extension that never returns.
test("a compiled binary runs as Pi's CLI when started with Pi's options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pipoca-pi-cli-"));
  const marker = join(dir, "ran");
  const extension = join(dir, "runner.js");

  await writeFile(
    extension,
    `import { writeFileSync } from "node:fs";
export default async function () {
  writeFileSync(${JSON.stringify(marker)}, "ran");
  process.exit(0);
}
`,
  );

  try {
    await run(
      binary,
      [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-session",
        "--mode",
        "rpc",
        "--extension",
        extension,
      ],
      {
        cwd: dir,
        env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") },
      },
    );

    expect(await readFile(marker, "utf8")).toBe("ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
