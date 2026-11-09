import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";
import type { HTMLBundle } from "bun";

interface BundleFile {
  readonly path: string;
  readonly loader: string;
  readonly headers: Readonly<Record<string, string>>;
}

type Route = (request: Request) => Promise<Response>;

const compressed: ReadonlySet<string> = new Set([
  "html",
  "js",
  "css",
  "json",
  "text",
]);

// Bun serves a compiled web bundle's files plain and without Cache-Control,
// and its routes win over any given for the same paths, so a compiled bundle
// is served here. Its file names carry a content hash, so a browser keeps them
// for good. A bundle built at startup, as in development, has no files.
export function webRoutes(
  bundle: HTMLBundle,
  pagePath: string,
): Record<string, HTMLBundle | Route> {
  const files = bundle.files ?? [];
  const page = files.find(({ loader }) => loader === "html");

  if (page === undefined) {
    return { [pagePath]: bundle };
  }

  const routes: Record<string, Route> = {};

  for (const file of files.filter((each) => each !== page)) {
    routes[`/${basename(file.path)}`] = fileRoute(
      file,
      "public, max-age=31536000, immutable",
    );
  }

  routes[pagePath] = fileRoute(page, "no-cache");

  return routes;
}

function fileRoute(file: BundleFile, cacheControl: string): Route {
  let bodies: Promise<{ plain: Buffer; gzip?: Buffer }> | undefined;

  return async (request) => {
    bodies ??= readFile(file.path).then((plain) => ({
      plain,
      ...(compressed.has(file.loader) && { gzip: gzipSync(plain) }),
    }));

    const { plain, gzip } = await bodies;

    const headers = {
      "content-type": file.headers["content-type"],
      "cache-control": cacheControl,
      vary: "accept-encoding",
    };

    return gzip !== undefined &&
      /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
      ? new Response(gzip, {
          headers: { ...headers, "content-encoding": "gzip" },
        })
      : new Response(plain, { headers });
  };
}
