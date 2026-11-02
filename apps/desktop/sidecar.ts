import { join } from "node:path";

// Tauri bundles an external binary named for the platform it runs on.
const bunTargets: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

const triple = process.env["TAURI_ENV_TARGET_TRIPLE"] ?? (await hostTriple());

const target = bunTargets[triple];
if (target === undefined) {
  throw new Error(`no pipoca build for ${triple}`);
}

const built = Bun.spawnSync(
  [
    "bun",
    "src/build.ts",
    "--target",
    target,
    "--outfile",
    join(import.meta.dir, "src-tauri", "binaries", `pipoca-${triple}`),
  ],
  {
    cwd: join(import.meta.dir, "..", "pipoca"),
    stdio: ["ignore", "inherit", "inherit"],
  },
);

process.exit(built.exitCode);

async function hostTriple(): Promise<string> {
  const info = await new Response(Bun.spawn(["rustc", "-vV"]).stdout).text();
  const host = /^host: (.+)$/m.exec(info)?.[1];
  if (host === undefined) {
    throw new Error("rustc -vV printed no host");
  }

  return host;
}
