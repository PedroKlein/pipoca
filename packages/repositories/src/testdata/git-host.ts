import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The server clones only over https and ssh, so a git server with a
// throwaway certificate stands in for a git host. It serves the bare
// repositories in the folder, and redirects each moved name to its new one.
export function gitHost(
  folder: string,
  moved: Readonly<Record<string, string>> = {},
): {
  readonly url: (name: string) => string;
  readonly stop: () => Promise<void>;
} {
  const certs = mkdtempSync(join(tmpdir(), "git-host-certs-"));

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-keyout",
      join(certs, "key.pem"),
      "-out",
      join(certs, "cert.pem"),
    ],
    { stdio: "ignore" },
  );

  process.env["GIT_SSL_NO_VERIFY"] = "true";

  const server = Bun.serve({
    port: 0,
    tls: {
      key: Bun.file(join(certs, "key.pem")),
      cert: Bun.file(join(certs, "cert.pem")),
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const [, name = ""] = /^\/([^/]+)\.git\//.exec(url.pathname) ?? [];
      const to = moved[name];

      if (to !== undefined) {
        url.pathname = url.pathname.replace(`/${name}.git/`, `/${to}.git/`);

        return Response.redirect(url.href, 302);
      }

      return httpBackend(request, folder);
    },
  });

  return {
    url: (name) => `https://localhost:${String(server.port)}/${name}.git`,
    stop: async () => {
      await server.stop(true);
      rmSync(certs, { recursive: true, force: true });
    },
  };
}

async function httpBackend(
  request: Request,
  projects: string,
): Promise<Response> {
  const url = new URL(request.url);

  const backend = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projects,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
    },
  });

  backend.stdin.end(Buffer.from(await request.arrayBuffer()));

  const chunks: Buffer[] = [];
  for await (const chunk of backend.stdout) {
    chunks.push(chunk as Buffer);
  }

  const output = Buffer.concat(chunks);
  const end = output.indexOf("\r\n\r\n");
  const headers = new Headers();
  let status = 200;

  for (const line of output.subarray(0, end).toString().split("\r\n")) {
    const [key = "", ...rest] = line.split(":");
    const value = rest.join(":").trim();

    if (key.toLowerCase() === "status") {
      status = Number(value.split(" ")[0]);
    } else {
      headers.set(key, value);
    }
  }

  return new Response(output.subarray(end + 4), { status, headers });
}
