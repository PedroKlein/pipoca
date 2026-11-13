import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string", default: "dist/pipoca" },
  },
});

// A compiled Pi reads its version from a package.json beside the binary, and
// a single-file deploy has none.
const piVersionPlugin: Bun.BunPlugin = {
  name: "pi-version",
  setup: (build) => {
    build.onLoad(
      { filter: /pi-coding-agent[\\/]dist[\\/]config\.js$/ },
      async ({ path }) => {
        const fallback = 'pkg.version || "0.0.0"';
        const source = await readFile(path, "utf8");

        const { version } = JSON.parse(
          await readFile(join(path, "..", "..", "package.json"), "utf8"),
        ) as { version: string };

        if (!source.includes(fallback)) {
          throw new Error(`Pi's version fallback moved in ${path}`);
        }

        return {
          contents: source.replace(fallback, JSON.stringify(version)),
          loader: "js",
        };
      },
    );
  },
};

// Photon reads its wasm beside its own source, which a deployed binary lacks.
const photonWasmPlugin: Bun.BunPlugin = {
  name: "photon-wasm",
  setup: (build) => {
    build.onLoad(
      { filter: /photon-node[\\/]photon_rs\.js$/ },
      async ({ path }) => {
        const beside = "require('path').join(__dirname, 'photon_rs_bg.wasm')";
        const source = await readFile(path, "utf8");

        if (!source.includes(beside)) {
          throw new Error(`Photon's wasm read moved in ${path}`);
        }

        return {
          contents: source.replace(beside, "require('./photon_rs_bg.wasm')"),
          loader: "js",
        };
      },
    );
  },
};

// The CLI's `bun build --compile` can't take plugins, and the web bundle needs Tailwind.
const result = await Bun.build({
  entrypoints: ["src/main.ts", "src/extensions/codemode/worker.ts"],
  root: ".",
  compile: {
    outfile: values.outfile,
    ...(values.target !== undefined && {
      target: values.target as Bun.Build.CompileTarget,
    }),
  },
  plugins: [tailwind, piVersionPlugin, photonWasmPlugin],
  // The web app loads big plugin dependencies, such as Mermaid, only when used.
  splitting: true,
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }

  process.exit(1);
}
