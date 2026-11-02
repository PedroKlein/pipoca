import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./serve";

const server = serve({ port: 0, database: ":memory:", log: () => undefined });

// Browsers fetch the manifest and its icons without the sign-in cookie, and
// need both to offer installing the web UI as an app (ADR 0053).
test("serves the web UI's app manifest and icons to a browser that isn't signed in", async () => {
  const page = readFileSync(
    join(import.meta.dir, "../../web/src/index.html"),
    "utf8",
  );

  const manifest = await fetch(new URL("/manifest.webmanifest", server.url));

  const { icons, display, start_url } = (await manifest.json()) as {
    icons: { src: string; sizes: string }[];
    display: string;
    start_url: string;
  };

  const fetched = await Promise.all(
    icons.map(async ({ src }) => fetch(new URL(src, server.url))),
  );

  expect(page).toContain('["manifest", "/manifest.webmanifest"]');

  expect(manifest.headers.get("content-type")).toBe(
    "application/manifest+json",
  );

  expect({ display, start_url }).toEqual({
    display: "standalone",
    start_url: "/",
  });

  expect(icons.map(({ sizes }) => sizes)).toContain("512x512");
  expect(fetched.map((icon) => icon.status)).toEqual(icons.map(() => 200));

  expect(fetched.map((icon) => icon.headers.get("content-type"))).toEqual(
    icons.map(() => "image/png"),
  );

  await server.stop();
});
